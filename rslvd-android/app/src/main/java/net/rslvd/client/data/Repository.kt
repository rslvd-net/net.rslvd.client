package net.rslvd.client.data

import android.content.Context
import com.squareup.moshi.Moshi
import org.json.JSONObject
import retrofit2.Response

/** Result of a login attempt — may require a second TOTP step. */
sealed class LoginResult {
    data class Success(val user: User?) : LoginResult()
    object RequiresTotp : LoginResult()
    data class Error(val message: String) : LoginResult()
}

class Repository private constructor(
    val tokenStore: TokenStore,
    private val api: ApiService,
) {
    suspend fun login(email: String, password: String, totp: String? = null): LoginResult {
        return try {
            val resp = api.login(LoginRequest(email.trim(), password, totp?.ifBlank { null }))
            val body = resp.body()
            when {
                !resp.isSuccessful -> LoginResult.Error(errorMessage(resp, "Login failed"))
                body?.requireTotp == true -> LoginResult.RequiresTotp
                body?.token != null -> {
                    tokenStore.token = body.token
                    tokenStore.email = body.user?.email ?: email.trim()
                    LoginResult.Success(body.user)
                }
                else -> LoginResult.Error(body?.error ?: "Login failed")
            }
        } catch (e: Exception) {
            LoginResult.Error(networkMessage(e))
        }
    }

    suspend fun register(email: String, password: String): LoginResult {
        return try {
            val resp = api.register(RegisterRequest(email.trim(), password, tosAccepted = true))
            val body = resp.body()
            if (resp.isSuccessful && body?.token != null) {
                tokenStore.token = body.token
                tokenStore.email = body.user?.email ?: email.trim()
                LoginResult.Success(body.user)
            } else {
                LoginResult.Error(errorMessage(resp, body?.error ?: "Registration failed"))
            }
        } catch (e: Exception) {
            LoginResult.Error(networkMessage(e))
        }
    }

    suspend fun me(): Result<User> = call { api.me() }

    suspend fun hosts(): Result<List<Host>> = call { api.hosts() }

    suspend fun updateHostIp(key: String, ip: String): Result<String> {
        return try {
            val resp = api.updateHostIp(key, ip)
            val body = resp.body()?.string()?.trim().orEmpty()
            if (resp.isSuccessful && (body.startsWith("good") || body.startsWith("nochg"))) {
                Result.success(body)
            } else {
                Result.failure(ApiException(body.ifBlank { errorMessage(resp, "Failed to update host IP") }, resp.code()))
            }
        } catch (e: Exception) {
            Result.failure(ApiException(networkMessage(e), -1))
        }
    }

    suspend fun createHost(hostname: String, forceHttps: Boolean): Result<Host> =
        call { api.createHost(CreateHostRequest(hostname.trim().lowercase(), forceHttps)) }

    suspend fun deleteHost(id: String): Result<Unit> = callUnit { api.deleteHost(id) }

    suspend fun tunnels(): Result<List<Tunnel>> = call { api.tunnels() }

    suspend fun createTunnel(name: String, port: Int, host: String, protocol: String, forceHttps: Boolean): Result<Tunnel> =
        call { api.createTunnel(CreateTunnelRequest(name.trim().lowercase(), port, host.trim().ifBlank { "localhost" }, protocol, forceHttps)) }

    suspend fun deleteTunnel(id: String): Result<Unit> = callUnit { api.deleteTunnel(id) }

    suspend fun plans(): Result<List<PlanInfo>> = call { api.plans() }

    suspend fun subscription(): Result<SubscriptionInfo> = call { api.subscription() }

    suspend fun cancelSubscription(): Result<Unit> = callUnit { api.cancelSubscription() }

    suspend fun tickets(): Result<List<SupportTicket>> = call { api.tickets() }

    suspend fun createTicket(subject: String, body: String): Result<SupportTicket> =
        call { api.createTicket(CreateTicketRequest(subject.trim(), body.trim())) }

    suspend fun ticket(id: Int): Result<TicketDetail> = call { api.ticket(id) }

    suspend fun replyTicket(id: Int, body: String): Result<TicketMessage> =
        call { api.replyTicket(id, TicketReplyRequest(body.trim())) }

    suspend fun escalateTicket(id: Int): Result<SupportTicket> = call { api.escalateTicket(id) }

    suspend fun deleteAccount(password: String): Result<Unit> =
        callUnit { api.deleteAccount(DeleteAccountRequest(password)) }

    fun logout() = tokenStore.clear()

    fun isLoggedIn() = tokenStore.isLoggedIn()

    // ── helpers ─────────────────────────────────────────────────────────────
    private suspend fun <T> call(block: suspend () -> Response<T>): Result<T> {
        return try {
            val resp = block()
            if (resp.isSuccessful && resp.body() != null) {
                Result.success(resp.body()!!)
            } else {
                Result.failure(ApiException(errorMessage(resp, "Request failed"), resp.code()))
            }
        } catch (e: Exception) {
            Result.failure(ApiException(networkMessage(e), -1))
        }
    }

    private suspend fun <T> callUnit(block: suspend () -> Response<T>): Result<Unit> {
        return try {
            val resp = block()
            if (resp.isSuccessful) Result.success(Unit)
            else Result.failure(ApiException(errorMessage(resp, "Request failed"), resp.code()))
        } catch (e: Exception) {
            Result.failure(ApiException(networkMessage(e), -1))
        }
    }

    private fun <T> errorMessage(resp: Response<T>, fallback: String): String {
        if (resp.code() == 401) return "Session expired — please sign in again"
        return try {
            val raw = resp.errorBody()?.string()
            if (raw.isNullOrBlank()) fallback else JSONObject(raw).optString("error", fallback)
        } catch (e: Exception) {
            fallback
        }
    }

    private fun networkMessage(e: Exception): String =
        e.message?.let { "Network error: $it" } ?: "Network error"

    companion object {
        @Volatile private var instance: Repository? = null

        fun get(context: Context): Repository {
            return instance ?: synchronized(this) {
                instance ?: run {
                    val store = TokenStore(context)
                    Repository(store, ApiClient.create(store)).also { instance = it }
                }
            }
        }
    }
}

class ApiException(message: String, val code: Int) : Exception(message)
