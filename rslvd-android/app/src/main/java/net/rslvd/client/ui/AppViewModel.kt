package net.rslvd.client.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import net.rslvd.client.data.Host
import net.rslvd.client.data.LoginResult
import net.rslvd.client.data.PlanInfo
import net.rslvd.client.data.SubscriptionInfo
import net.rslvd.client.data.Repository
import net.rslvd.client.data.SupportTicket
import net.rslvd.client.data.TicketDetail
import net.rslvd.client.data.Tunnel
import net.rslvd.client.data.User
import net.rslvd.client.ddns.DdnsConfig
import net.rslvd.client.ddns.DdnsScheduler
import net.rslvd.client.ddns.DdnsTarget
import net.rslvd.client.tunnel.TunnelService

data class HostsState(
    val loading: Boolean = false,
    val items: List<Host> = emptyList(),
    val error: String? = null,
)

data class TunnelsState(
    val loading: Boolean = false,
    val items: List<Tunnel> = emptyList(),
    val error: String? = null,
)

data class SupportState(
    val loading: Boolean = false,
    val tickets: List<SupportTicket> = emptyList(),
    val viewing: TicketDetail? = null,
    val error: String? = null,
)

data class BillingState(
    val loading: Boolean = false,
    val plans: List<PlanInfo> = emptyList(),
    val subscription: SubscriptionInfo? = null,
    val error: String? = null,
)

class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val repo = Repository.get(app)
    private val ddnsConfig = DdnsConfig(app)

    private val _authed = MutableStateFlow(repo.isLoggedIn())
    val authed: StateFlow<Boolean> = _authed.asStateFlow()

    private val _user = MutableStateFlow<User?>(null)
    val user: StateFlow<User?> = _user.asStateFlow()

    private val _hosts = MutableStateFlow(HostsState())
    val hosts: StateFlow<HostsState> = _hosts.asStateFlow()

    private val _tunnels = MutableStateFlow(TunnelsState())
    val tunnels: StateFlow<TunnelsState> = _tunnels.asStateFlow()

    private val _snackbar = MutableStateFlow<String?>(null)
    val snackbar: StateFlow<String?> = _snackbar.asStateFlow()

    private val _billing = MutableStateFlow(BillingState())
    val billing: StateFlow<BillingState> = _billing.asStateFlow()

    private val _support = MutableStateFlow(SupportState())
    val support: StateFlow<SupportState> = _support.asStateFlow()

    private val _ddns = MutableStateFlow(DdnsUiState())
    val ddns: StateFlow<DdnsUiState> = _ddns.asStateFlow()

    val accountEmail: String? get() = repo.tokenStore.email

    init {
        if (_authed.value) refreshUser()
        refreshDdns()
    }

    fun snackbarShown() { _snackbar.value = null }
    private fun toast(msg: String) { _snackbar.value = msg }

    fun copyText(label: String, text: String, sensitive: Boolean = false) {
        val cm = getApplication<Application>()
            .getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        val clip = android.content.ClipData.newPlainText(label, text)
        if (sensitive) {
            clip.description.extras = android.os.PersistableBundle().apply {
                putBoolean("android.content.extra.IS_SENSITIVE", true)
            }
        }
        cm.setPrimaryClip(clip)
        toast("Copied $label")
    }

    // ── Auth ─────────────────────────────────────────────────────────────────
    fun login(email: String, password: String, totp: String?, onResult: (LoginResult) -> Unit) {
        viewModelScope.launch {
            val result = repo.login(email, password, totp)
            if (result is LoginResult.Success) {
                _authed.value = true
                _user.value = result.user
                loadAll()
            }
            onResult(result)
        }
    }

    fun register(email: String, password: String, onResult: (LoginResult) -> Unit) {
        viewModelScope.launch {
            val result = repo.register(email, password)
            if (result is LoginResult.Success) {
                _authed.value = true
                _user.value = result.user
                loadAll()
            }
            onResult(result)
        }
    }

    fun logout() {
        repo.logout()
        _authed.value = false
        _user.value = null
        _hosts.value = HostsState()
        _tunnels.value = TunnelsState()
    }

    fun refreshUser() {
        viewModelScope.launch {
            repo.me().onSuccess { _user.value = it }
                .onFailure { if ((it as? net.rslvd.client.data.ApiException)?.code == 401) logout() }
        }
    }

    private fun loadAll() {
        loadHosts()
        loadTunnels()
        refreshDdns()
    }

    // ── Hosts ──────────────────────────────────────────────────────────────────
    fun loadHosts() {
        _hosts.value = _hosts.value.copy(loading = true, error = null)
        viewModelScope.launch {
            repo.hosts()
                .onSuccess { _hosts.value = HostsState(items = it) }
                .onFailure { handleAuthError(it); _hosts.value = _hosts.value.copy(loading = false, error = it.message) }
        }
    }

    fun createHost(hostname: String, forceHttps: Boolean, onDone: (Boolean) -> Unit) {
        viewModelScope.launch {
            repo.createHost(hostname, forceHttps)
                .onSuccess { toast("Created ${it.fqdn}"); loadHosts(); refreshDdns(); onDone(true) }
                .onFailure { toast(it.message ?: "Failed to create host"); onDone(false) }
        }
    }

    fun deleteHost(host: Host) {
        viewModelScope.launch {
            repo.deleteHost(host.id)
                .onSuccess {
                    val targetId = "host-${host.id}"
                    val hadTarget = ddnsConfig.getTargets().any { it.id == targetId }
                    if (hadTarget) ddnsConfig.removeTarget(targetId)
                    toast(if (hadTarget) "Deleted ${host.fqdn} and removed its DDNS target" else "Deleted ${host.fqdn}")
                    loadHosts(); refreshDdns()
                }
                .onFailure { toast(it.message ?: "Failed to delete host") }
        }
    }

    fun setHostIp(host: Host, ip: String, onDone: (Boolean) -> Unit) {
        val normalized = ip.trim()
        if (!isValidIpv4(normalized)) {
            toast("Enter a valid IPv4 address")
            onDone(false)
            return
        }
        val key = host.updateKey
        if (key.isNullOrBlank()) {
            toast("This host has no update key")
            onDone(false)
            return
        }
        viewModelScope.launch {
            repo.updateHostIp(key, normalized)
                .onSuccess { toast("Updated ${host.fqdn} to $normalized"); loadHosts(); onDone(true) }
                .onFailure { toast(it.message ?: "Failed to update host IP"); onDone(false) }
        }
    }

    private fun isValidIpv4(value: String): Boolean {
        val parts = value.split('.')
        return parts.size == 4 && parts.all { it.isNotEmpty() && it.toIntOrNull()?.let { octet -> octet in 0..255 } == true }
    }

    // ── Tunnels ──────────────────────────────────────────────────────────────
    fun loadTunnels() {
        _tunnels.value = _tunnels.value.copy(loading = true, error = null)
        viewModelScope.launch {
            repo.tunnels()
                .onSuccess { _tunnels.value = TunnelsState(items = it) }
                .onFailure { handleAuthError(it); _tunnels.value = _tunnels.value.copy(loading = false, error = it.message) }
        }
    }

    fun createTunnel(name: String, port: Int, host: String, protocol: String, forceHttps: Boolean, onDone: (Boolean) -> Unit) {
        viewModelScope.launch {
            repo.createTunnel(name, port, host, protocol, forceHttps)
                .onSuccess { toast("Created ${it.fqdn ?: it.name}"); loadTunnels(); onDone(true) }
                .onFailure { toast(it.message ?: "Failed to create tunnel"); onDone(false) }
        }
    }

    fun deleteTunnel(tunnel: Tunnel) {
        viewModelScope.launch {
            repo.deleteTunnel(tunnel.id)
                .onSuccess { toast("Deleted ${tunnel.name}"); loadTunnels() }
                .onFailure { toast(it.message ?: "Failed to delete tunnel") }
        }
    }

    fun connectTunnel(tunnel: Tunnel) {
        val token = tunnel.token
        val port = tunnel.targetPort
        if (token.isNullOrBlank() || port == null) {
            toast("This tunnel has no connect token")
            return
        }
        TunnelService.start(
            getApplication(),
            id = tunnel.id,
            name = tunnel.fqdn ?: tunnel.name,
            token = token,
            protocol = tunnel.protocol ?: "tcp",
            targetHost = tunnel.targetHost ?: "localhost",
            targetPort = port,
        )
        refreshTunnelsSoon()
    }

    fun disconnectTunnel(tunnel: Tunnel) {
        TunnelService.stop(getApplication(), tunnel.id)
        refreshTunnelsSoon()
    }

    /** Re-fetch tunnels a few times so server-side connected state becomes visible. */
    private fun refreshTunnelsSoon() {
        viewModelScope.launch {
            repeat(3) {
                kotlinx.coroutines.delay(3000)
                loadTunnels()
            }
        }
    }

    // ── Billing ──────────────────────────────────────────────────────────────
    fun loadBilling() {
        _billing.value = _billing.value.copy(loading = true, error = null)
        viewModelScope.launch {
            val plans = repo.plans().getOrElse { handleAuthError(it); emptyList() }
            repo.subscription()
                .onSuccess { _billing.value = BillingState(plans = plans, subscription = it) }
                .onFailure {
                    handleAuthError(it)
                    _billing.value = BillingState(plans = plans, error = if (plans.isEmpty()) it.message else null)
                }
        }
    }

    fun cancelSubscription(onDone: (Boolean) -> Unit) {
        viewModelScope.launch {
            repo.cancelSubscription()
                .onSuccess { toast("Subscription will end at your paid-through date"); loadBilling(); refreshUser(); onDone(true) }
                .onFailure { toast(it.message ?: "Cancellation failed"); onDone(false) }
        }
    }

    // ── Support ─────────────────────────────────────────────────────────────
    fun loadTickets() {
        _support.value = _support.value.copy(loading = true, error = null)
        viewModelScope.launch {
            repo.tickets()
                .onSuccess { _support.value = _support.value.copy(loading = false, tickets = it) }
                .onFailure { handleAuthError(it); _support.value = _support.value.copy(loading = false, error = it.message) }
        }
    }

    fun openTicket(id: Int) {
        viewModelScope.launch {
            repo.ticket(id)
                .onSuccess { _support.value = _support.value.copy(viewing = it) }
                .onFailure { toast(it.message ?: "Failed to load ticket") }
        }
    }

    /** Silently refresh the open thread (used for AI-reply polling). */
    fun refreshOpenTicket() {
        val current = _support.value.viewing ?: return
        viewModelScope.launch {
            repo.ticket(current.id).onSuccess {
                if (_support.value.viewing?.id == it.id) _support.value = _support.value.copy(viewing = it)
            }
        }
    }

    fun closeTicketView() {
        _support.value = _support.value.copy(viewing = null)
        loadTickets()
    }

    fun createTicket(subject: String, body: String, onDone: (Boolean) -> Unit) {
        viewModelScope.launch {
            repo.createTicket(subject, body)
                .onSuccess { openTicket(it.id); loadTickets(); onDone(true) }
                .onFailure { toast(it.message ?: "Failed to create ticket"); onDone(false) }
        }
    }

    fun replyTicket(body: String, onDone: (Boolean) -> Unit) {
        val ticket = _support.value.viewing ?: return onDone(false)
        viewModelScope.launch {
            repo.replyTicket(ticket.id, body)
                .onSuccess { openTicket(ticket.id); onDone(true) }
                .onFailure { toast(it.message ?: "Failed to send reply"); onDone(false) }
        }
    }

    fun escalateTicket() {
        val ticket = _support.value.viewing ?: return
        viewModelScope.launch {
            repo.escalateTicket(ticket.id)
                .onSuccess { toast("Escalated — the site owner has been notified"); openTicket(ticket.id); loadTickets() }
                .onFailure { toast(it.message ?: "Failed to escalate") }
        }
    }

    private fun handleAuthError(t: Throwable) {
        if ((t as? net.rslvd.client.data.ApiException)?.code == 401) logout()
    }

    // ── DDNS ───────────────────────────────────────────────────────────────────
    fun refreshDdns() {
        _ddns.value = DdnsUiState(
            enabled = ddnsConfig.enabled,
            intervalMinutes = ddnsConfig.intervalMinutes,
            lastDetectedIp = ddnsConfig.lastDetectedIp,
            lastRun = ddnsConfig.lastRun,
            targets = ddnsConfig.getTargets(),
        )
    }

    fun setDdnsEnabled(enabled: Boolean) {
        ddnsConfig.enabled = enabled
        DdnsScheduler.schedule(getApplication())
        if (enabled) toast("Background DDNS updates enabled") else toast("Background DDNS updates disabled")
        refreshDdns()
    }

    fun setDdnsInterval(minutes: Long) {
        ddnsConfig.intervalMinutes = minutes
        if (ddnsConfig.enabled) DdnsScheduler.schedule(getApplication())
        refreshDdns()
    }

    /** Add a target for an rslvd host using its update key. */
    fun addRslvdTarget(host: Host) {
        val key = host.updateKey
        if (key.isNullOrBlank()) { toast("This host has no update key"); return }
        if (ddnsConfig.getTargets().any { it.id == "host-${host.id}" }) {
            toast("${host.fqdn} is already a DDNS target")
            return
        }
        ddnsConfig.addTarget(
            DdnsTarget(
                id = "host-${host.id}",
                label = host.fqdn,
                urlTemplate = DdnsTarget.rslvdUrl(key),
                provider = DdnsTarget.PROVIDER_RSLVD,
            )
        )
        toast("Added ${host.fqdn} to DDNS")
        refreshDdns()
    }

    fun addCustomTarget(label: String, urlTemplate: String, onDone: (Boolean) -> Unit) {
        val url = urlTemplate.trim()
        if (label.isBlank() || !url.contains(DdnsTarget.IP_TOKEN)) {
            toast("URL must contain ${DdnsTarget.IP_TOKEN}")
            onDone(false)
            return
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            toast("URL must start with http:// or https://")
            onDone(false)
            return
        }
        ddnsConfig.addTarget(
            DdnsTarget(
                id = "custom-${System.currentTimeMillis()}",
                label = label.trim(),
                urlTemplate = url,
                provider = DdnsTarget.PROVIDER_CUSTOM,
            )
        )
        toast("Added $label to DDNS")
        refreshDdns()
        onDone(true)
    }

    fun removeTarget(id: String) {
        val target = ddnsConfig.getTargets().find { it.id == id }
        ddnsConfig.removeTarget(id)
        toast("Removed ${target?.label ?: "target"} from DDNS")
        refreshDdns()
    }

    fun restoreTarget(target: DdnsTarget) {
        ddnsConfig.addTarget(target)
        refreshDdns()
    }

    fun runDdnsNow() {
        if (ddnsConfig.getTargets().isEmpty()) { toast("Add at least one DDNS target first"); return }
        DdnsScheduler.runNow(getApplication())
        toast("Updating now…")
        viewModelScope.launch {
            repeat(8) {
                kotlinx.coroutines.delay(4000)
                refreshDdns()
            }
            loadHosts()
        }
    }

    fun deleteAccount(password: String, onDone: (Boolean) -> Unit) {
        viewModelScope.launch {
            repo.deleteAccount(password)
                .onSuccess { toast("Account deleted"); logout(); onDone(true) }
                .onFailure { toast(it.message ?: "Failed to delete account"); onDone(false) }
        }
    }
}

data class DdnsUiState(
    val enabled: Boolean = false,
    val intervalMinutes: Long = 15,
    val lastDetectedIp: String? = null,
    val lastRun: Long = 0L,
    val targets: List<DdnsTarget> = emptyList(),
)
