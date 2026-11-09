// rslvd.net — full app v2
const { useState, useEffect, useCallback, useRef } = React;

// ── API ─────────────────────────────────────────────────────────────────────
const API = {
  token: () => localStorage.getItem('token'),
  headers: () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${API.token()}` }),

  async req(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method, headers: API.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  },

  get: (p) => API.req('GET', p),
  post: (p, b) => API.req('POST', p, b),
  delete: (p) => API.req('DELETE', p),
  patch: (p, b) => API.req('PATCH', p, b),
};

// ── Router ───────────────────────────────────────────────────────────────────
function useRoute() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const handler = () => setPath(window.location.pathname);
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);
  const navigate = (to) => { window.history.pushState({}, '', to); setPath(to); };
  return { path, navigate };
}

// ── Auth Context ──────────────────────────────────────────────────────────────
function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (API.token()) {
      API.get('/auth/me').then(setUser).catch(() => localStorage.removeItem('token')).finally(() => setLoading(false));
    } else { setLoading(false); }
  }, []);

  const login = async (email, password) => {
    const data = await API.post('/auth/login', { email, password });
    localStorage.setItem('token', data.token);
    setUser(data.user);
    return data;
  };

  const register = async (email, password) => {
    const data = await API.post('/auth/register', { email, password });
    localStorage.setItem('token', data.token);
    setUser(data.user);
    return data;
  };

  const logout = () => {
    localStorage.removeItem('token');
    setUser(null);
  };

  const refreshUser = async () => {
    const u = await API.get('/auth/me');
    setUser(u);
    return u;
  };

  return { user, loading, login, register, logout, refreshUser };
}

// ── Components ────────────────────────────────────────────────────────────────
function Spinner() {
  return React.createElement('div', { className: 'spinner' });
}

function Alert({ type = 'error', children }) {
  return React.createElement('div', { className: `alert alert-${type}` }, children);
}

function CopyBox({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return React.createElement('div', { className: 'copy-box' },
    React.createElement('span', { className: 'copy-box-text', title: text }, text),
    React.createElement('button', { onClick: copy }, copied ? '✓ Copied' : 'Copy')
  );
}

// ── Nav ───────────────────────────────────────────────────────────────────────
function Nav({ user, logout, navigate }) {
  return React.createElement('nav', { className: 'nav' },
    React.createElement('div', { className: 'nav-logo', onClick: () => navigate('/'), style: { cursor: 'pointer' } },
      'rslvd', React.createElement('span', null, '.net')
    ),
    React.createElement('div', { className: 'nav-links' },
      user ? [
        React.createElement('button', { key: 'dash', className: 'btn btn-secondary btn-sm', onClick: () => navigate('/dashboard') }, 'Dashboard'),
        React.createElement('button', { key: 'out', className: 'btn btn-secondary btn-sm', onClick: () => { logout(); navigate('/'); } }, 'Sign out'),
      ] : [
        React.createElement('button', { key: 'in', className: 'btn btn-secondary btn-sm', onClick: () => navigate('/login') }, 'Sign in'),
        React.createElement('button', { key: 'up', className: 'btn btn-primary btn-sm', onClick: () => navigate('/register') }, 'Get started'),
      ]
    )
  );
}

// ── Landing ───────────────────────────────────────────────────────────────────
function Landing({ navigate }) {
  const plans = [
    { key: 'monthly', name: 'Monthly', price: '$0.99', period: '/month', hosts: 3, popular: false },
    { key: 'quarterly', name: 'Quarterly', price: '$1.99', period: '/3 months', hosts: 5, popular: false },
    { key: 'semi_annual', name: '6 Months', price: '$4.99', period: '/6 months', hosts: 10, popular: true },
    { key: 'annual', name: 'Annual', price: '$8.99', period: '/year', hosts: 25, popular: false },
  ];

  return React.createElement('div', null,
    // Hero
    React.createElement('div', { className: 'hero' },
      React.createElement('div', {
        style: { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 16px', background: 'var(--accent-bg)', border: '1px solid rgba(108,99,255,0.3)', borderRadius: 999, fontSize: 13, color: 'var(--accent2)', marginBottom: 24 }
      }, '⚡ Fast • Reliable • Simple'),
      React.createElement('h1', null,
        'Dynamic DNS\n',
        React.createElement('span', { style: { color: 'var(--accent2)' } }, 'that just works')
      ),
      React.createElement('p', null, 'Keep your subdomains on rslvd.net always pointing to your home or office IP. DynDNS-compatible, updates in seconds.'),
      React.createElement('div', { style: { display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' } },
        React.createElement('button', { className: 'btn btn-primary btn-lg', onClick: () => navigate('/register') }, 'Start for $0.99 →'),
        React.createElement('button', { className: 'btn btn-secondary btn-lg', onClick: () => document.getElementById('pricing').scrollIntoView({ behavior: 'smooth' }) }, 'View plans')
      )
    ),

    // Features
    React.createElement('div', { style: { maxWidth: 960, margin: '0 auto 80px', padding: '0 24px' } },
      React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 20 } },
        ...[
          { icon: '🔄', title: 'Auto-updates', desc: 'Your IP changes? DNS follows. Under 60 seconds to propagate.' },
          { icon: '🔗', title: 'DynDNS Compatible', desc: 'Works with routers, NAS devices, and any DynDNS client out of the box.' },
          { icon: '🌐', title: 'IPv4 & IPv6', desc: 'Full dual-stack support. A and AAAA records updated simultaneously.' },
          { icon: '🔒', title: 'Per-host keys', desc: 'Each host gets a unique update key. Rotate anytime from your dashboard.' },
        ].map(f => React.createElement('div', { key: f.title, className: 'card' },
          React.createElement('div', { style: { fontSize: 28, marginBottom: 12 } }, f.icon),
          React.createElement('h3', { style: { marginBottom: 8 } }, f.title),
          React.createElement('p', { style: { color: 'var(--text2)', fontSize: 14 } }, f.desc)
        ))
      )
    ),

    // How it works
    React.createElement('div', { style: { maxWidth: 720, margin: '0 auto 80px', padding: '0 24px', textAlign: 'center' } },
      React.createElement('h2', { style: { fontSize: 28, marginBottom: 12 } }, 'How it works'),
      React.createElement('p', { style: { color: 'var(--text2)', marginBottom: 40 } }, 'Three steps and you\'re live.'),
      React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 20, textAlign: 'left' } },
        ...[
          { n: '01', title: 'Create account', desc: 'Sign up, pick a plan and get access to your dashboard.' },
          { n: '02', title: 'Add a hostname', desc: 'Choose a subdomain like home.rslvd.net. Get your unique update key.' },
          { n: '03', title: 'Configure your router', desc: 'Point your router\'s DDNS to our URL. Done.' },
        ].map(s => React.createElement('div', { key: s.n, className: 'card' },
          React.createElement('div', { style: { fontSize: 12, color: 'var(--accent2)', fontWeight: 700, marginBottom: 8 } }, s.n),
          React.createElement('h3', { style: { marginBottom: 8 } }, s.title),
          React.createElement('p', { style: { color: 'var(--text2)', fontSize: 14 } }, s.desc)
        ))
      )
    ),

    // Pricing
    React.createElement('div', { id: 'pricing', style: { textAlign: 'center', marginBottom: 80, paddingTop: 20 } },
      React.createElement('h2', { style: { fontSize: 28, marginBottom: 8 } }, 'Simple pricing'),
      React.createElement('p', { style: { color: 'var(--text2)', marginBottom: 40 } }, 'No setup fees. Cancel anytime.'),
      React.createElement('div', { className: 'pricing-grid' },
        ...plans.map(p => React.createElement('div', { key: p.key, className: `pricing-card${p.popular ? ' popular' : ''}` },
          p.popular && React.createElement('div', { className: 'popular-badge' }, 'Best value'),
          React.createElement('h3', { style: { color: 'var(--text2)', fontSize: 14, textTransform: 'uppercase', letterSpacing: 1 } }, p.name),
          React.createElement('div', { className: 'price-amount' }, p.price),
          React.createElement('div', { className: 'price-period' }, p.period),
          React.createElement('ul', { className: 'price-features' },
            React.createElement('li', null, `Up to ${p.hosts} hostnames`),
            React.createElement('li', null, 'IPv4 + IPv6 support'),
            React.createElement('li', null, 'DynDNS compatible'),
            React.createElement('li', null, 'Per-host update keys'),
            React.createElement('li', null, '60s update interval'),
          ),
          React.createElement('button', { className: 'btn btn-primary w-full', onClick: () => navigate('/register') }, 'Get started')
        ))
      )
    ),

    // DynDNS URL example
    React.createElement('div', { style: { maxWidth: 720, margin: '0 auto 80px', padding: '0 24px' } },
      React.createElement('h2', { style: { fontSize: 22, marginBottom: 20, textAlign: 'center' } }, 'Update URL format'),
      React.createElement('div', { className: 'card' },
        React.createElement('p', { style: { color: 'var(--text2)', fontSize: 14, marginBottom: 12 } }, 'Use this URL in your router or DDNS client:'),
        React.createElement(CopyBox, { text: 'https://rslvd.net/api/update?key=YOUR_UPDATE_KEY&ip=auto' }),
        React.createElement('div', { style: { marginTop: 16, display: 'grid', gap: 8 } },
          ...[
            { param: 'key', desc: 'Your host\'s unique update key (from dashboard)' },
            { param: 'ip', desc: 'IPv4 address, or "auto" to detect from request' },
            { param: 'ipv6', desc: '(optional) IPv6 address' },
          ].map(p => React.createElement('div', { key: p.param, style: { display: 'flex', gap: 12, fontSize: 13 } },
            React.createElement('code', { style: { color: 'var(--accent2)', minWidth: 60 } }, p.param),
            React.createElement('span', { style: { color: 'var(--text2)' } }, p.desc)
          ))
        )
      )
    ),

    // Footer
    React.createElement('footer', { style: { borderTop: '1px solid var(--border)', padding: '32px 24px', textAlign: 'center', color: 'var(--text3)', fontSize: 14 } },
      React.createElement('div', null, '© 2026 rslvd.net — Dynamic DNS Service'),
      React.createElement('div', { style: { marginTop: 8, display: 'flex', gap: 20, justifyContent: 'center' } },
        React.createElement('a', { href: '#pricing' }, 'Pricing'),
        React.createElement('span', { style: { cursor: 'pointer', color: 'var(--accent2)' }, onClick: () => window.navigate && window.navigate('/login') }, 'Sign in')
      )
    )
  );
}

// ── Auth Pages ────────────────────────────────────────────────────────────────
function LoginPage({ login, navigate }) {
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      await login(email, pass);
      navigate('/dashboard');
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  return React.createElement('div', { className: 'auth-wrap' },
    React.createElement('div', { className: 'auth-card card' },
      React.createElement('h1', { className: 'auth-title' }, 'Welcome back'),
      React.createElement('p', { className: 'auth-subtitle' }, 'Sign in to manage your hostnames'),
      error && React.createElement(Alert, { type: 'error' }, error),
      React.createElement('form', { onSubmit: submit },
        React.createElement('div', { className: 'form-group' },
          React.createElement('label', { className: 'form-label' }, 'Email'),
          React.createElement('input', { className: 'input', type: 'email', value: email, onChange: e => setEmail(e.target.value), placeholder: 'you@example.com', required: true, autoFocus: true })
        ),
        React.createElement('div', { className: 'form-group' },
          React.createElement('label', { className: 'form-label' }, 'Password'),
          React.createElement('input', { className: 'input', type: 'password', value: pass, onChange: e => setPass(e.target.value), placeholder: '••••••••', required: true })
        ),
        React.createElement('button', { className: 'btn btn-primary w-full', type: 'submit', disabled: loading, style: { marginTop: 8 } },
          loading ? React.createElement(Spinner) : 'Sign in'
        )
      ),
      React.createElement('div', { className: 'divider' }),
      React.createElement('p', { className: 'text-center text-sm text-muted' },
        "Don't have an account? ",
        React.createElement('a', { href: '#', onClick: (e) => { e.preventDefault(); navigate('/register'); } }, 'Create one')
      )
    )
  );
}

function RegisterPage({ register, navigate }) {
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (pass !== pass2) return setError('Passwords do not match');
    if (pass.length < 8) return setError('Password must be at least 8 characters');
    setLoading(true);
    try {
      await register(email, pass);
      navigate('/dashboard');
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  return React.createElement('div', { className: 'auth-wrap' },
    React.createElement('div', { className: 'auth-card card' },
      React.createElement('h1', { className: 'auth-title' }, 'Create account'),
      React.createElement('p', { className: 'auth-subtitle' }, 'Get your dynamic DNS hostname in minutes'),
      error && React.createElement(Alert, { type: 'error' }, error),
      React.createElement('form', { onSubmit: submit },
        React.createElement('div', { className: 'form-group' },
          React.createElement('label', { className: 'form-label' }, 'Email'),
          React.createElement('input', { className: 'input', type: 'email', value: email, onChange: e => setEmail(e.target.value), placeholder: 'you@example.com', required: true, autoFocus: true })
        ),
        React.createElement('div', { className: 'form-group' },
          React.createElement('label', { className: 'form-label' }, 'Password'),
          React.createElement('input', { className: 'input', type: 'password', value: pass, onChange: e => setPass(e.target.value), placeholder: 'At least 8 characters', required: true })
        ),
        React.createElement('div', { className: 'form-group' },
          React.createElement('label', { className: 'form-label' }, 'Confirm password'),
          React.createElement('input', { className: 'input', type: 'password', value: pass2, onChange: e => setPass2(e.target.value), placeholder: '••••••••', required: true })
        ),
        React.createElement('button', { className: 'btn btn-primary w-full', type: 'submit', disabled: loading, style: { marginTop: 8 } },
          loading ? React.createElement(Spinner) : 'Create account'
        )
      ),
      React.createElement('div', { className: 'divider' }),
      React.createElement('p', { className: 'text-center text-sm text-muted' },
        'Already have an account? ',
        React.createElement('a', { href: '#', onClick: (e) => { e.preventDefault(); navigate('/login'); } }, 'Sign in')
      )
    )
  );
}

// ── Add Host Modal ────────────────────────────────────────────────────────────
function AddHostModal({ onClose, onCreated }) {
  const [hostname, setHostname] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const host = await API.post('/hosts', { hostname: hostname.toLowerCase() });
      onCreated(host);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  return React.createElement('div', { className: 'modal-overlay', onClick: (e) => e.target === e.currentTarget && onClose() },
    React.createElement('div', { className: 'modal' },
      React.createElement('h2', { className: 'modal-title' }, 'Add hostname'),
      error && React.createElement(Alert, { type: 'error' }, error),
      React.createElement('form', { onSubmit: submit },
        React.createElement('div', { className: 'form-group' },
          React.createElement('label', { className: 'form-label' }, 'Subdomain'),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 0 } },
            React.createElement('input', {
              className: 'input', value: hostname,
              onChange: e => setHostname(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')),
              placeholder: 'myhome', required: true, autoFocus: true,
              style: { borderRadius: '8px 0 0 8px', borderRight: 'none' }
            }),
            React.createElement('span', {
              style: { padding: '10px 14px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: '0 8px 8px 0', color: 'var(--text2)', fontSize: 14, whiteSpace: 'nowrap' }
            }, '.rslvd.net')
          ),
          React.createElement('p', { className: 'form-hint' }, 'Lowercase letters, numbers and hyphens only')
        ),
        React.createElement('div', { style: { display: 'flex', gap: 12, justifyContent: 'flex-end' } },
          React.createElement('button', { type: 'button', className: 'btn btn-secondary', onClick: onClose }, 'Cancel'),
          React.createElement('button', { type: 'submit', className: 'btn btn-primary', disabled: loading },
            loading ? React.createElement(Spinner) : 'Create host'
          )
        )
      )
    )
  );
}

// ── Host Row ──────────────────────────────────────────────────────────────────
function HostRow({ host, onDelete, onRegenKey }) {
  const [showKey, setShowKey] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [regen, setRegen] = useState(false);

  const updateUrl = `https://rslvd.net/api/update?key=${host.update_key}&ip=auto`;

  const handleDelete = async () => {
    if (!confirm(`Delete ${host.fqdn}? This will remove the DNS record.`)) return;
    setDeleting(true);
    try { await API.delete(`/hosts/${host.id}`); onDelete(host.id); }
    catch (err) { alert(err.message); setDeleting(false); }
  };

  const handleRegen = async () => {
    if (!confirm('Regenerate update key? Your current DDNS configuration will stop working.')) return;
    setRegen(true);
    try {
      const data = await API.post(`/hosts/${host.id}/regenerate-key`);
      onRegenKey(host.id, data.update_key);
    } catch (err) { alert(err.message); }
    finally { setRegen(false); }
  };

  return React.createElement('tr', null,
    React.createElement('td', null,
      React.createElement('div', { style: { fontWeight: 500 } }, host.fqdn),
      React.createElement('div', { style: { fontSize: 12, color: 'var(--text3)', marginTop: 2 } },
        host.last_updated ? `Updated ${new Date(host.last_updated).toLocaleDateString()}` : 'Never updated'
      )
    ),
    React.createElement('td', null,
      host.ip_address
        ? React.createElement('code', { style: { fontSize: 13 } }, host.ip_address)
        : React.createElement('span', { style: { color: 'var(--text3)', fontSize: 13 } }, '—')
    ),
    React.createElement('td', null,
      React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 360 } },
        React.createElement(CopyBox, { text: updateUrl }),
        React.createElement('div', { style: { display: 'flex', gap: 8 } },
          React.createElement('button', { className: 'btn btn-secondary btn-sm', onClick: () => setShowKey(!showKey) }, showKey ? 'Hide key' : 'Show key'),
          React.createElement('button', { className: 'btn btn-secondary btn-sm', onClick: handleRegen, disabled: regen }, 'Rotate key'),
        ),
        showKey && React.createElement('code', { style: { fontSize: 12, color: 'var(--text2)', wordBreak: 'break-all' } }, host.update_key)
      )
    ),
    React.createElement('td', null,
      React.createElement('button', { className: 'btn btn-danger btn-sm', onClick: handleDelete, disabled: deleting },
        deleting ? React.createElement(Spinner) : 'Delete'
      )
    )
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function Dashboard({ user, navigate, refreshUser }) {
  const [hosts, setHosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [tab, setTab] = useState('hosts');
  const [plans, setPlans] = useState([]);
  const [checkoutLoading, setCheckoutLoading] = useState('');
  const [portalLoading, setPortalLoading] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('payment') === 'success') {
      setMsg('Payment successful! Your subscription is now active.');
      setTimeout(() => refreshUser(), 2000);
      window.history.replaceState({}, '', '/dashboard');
    }
  }, []);

  useEffect(() => {
    Promise.all([
      API.get('/hosts'),
      API.get('/billing/plans'),
    ]).then(([h, p]) => { setHosts(h); setPlans(p); }).finally(() => setLoading(false));
  }, []);

  const onHostCreated = (host) => { setHosts(h => [host, ...h]); setShowAdd(false); };
  const onHostDeleted = (id) => setHosts(h => h.filter(x => x.id !== id));
  const onRegenKey = (id, key) => setHosts(h => h.map(x => x.id === id ? { ...x, update_key: key } : x));

  const handleCheckout = async (planKey) => {
    setCheckoutLoading(planKey);
    try {
      const data = await API.post('/billing/checkout', { plan: planKey });
      window.location.href = data.url;
    } catch (err) { alert(err.message); setCheckoutLoading(''); }
  };

  const handlePortal = async () => {
    setPortalLoading(true);
    try {
      const data = await API.post('/billing/portal');
      window.location.href = data.url;
    } catch (err) { alert(err.message); setPortalLoading(false); }
  };

  const statusBadge = (s) => {
    if (s === 'active') return React.createElement('span', { className: 'badge badge-green' }, '● Active');
    if (s === 'past_due') return React.createElement('span', { className: 'badge badge-yellow' }, '● Past due');
    return React.createElement('span', { className: 'badge badge-gray' }, '○ Inactive');
  };

  const planLabel = { monthly: 'Monthly', quarterly: 'Quarterly', semi_annual: '6 Months', annual: 'Annual', none: 'No plan' };

  if (loading) return React.createElement('div', { className: 'flex-center', style: { minHeight: 400 } }, React.createElement(Spinner));

  return React.createElement('div', { className: 'dashboard' },
    msg && React.createElement(Alert, { type: 'success' }, msg),

    // Header
    React.createElement('div', { className: 'dashboard-header' },
      React.createElement('div', null,
        React.createElement('h1', { style: { fontSize: 24, marginBottom: 4 } }, 'Dashboard'),
        React.createElement('p', { style: { color: 'var(--text2)', fontSize: 14 } }, user.email)
      ),
      React.createElement('div', { style: { display: 'flex', gap: 8 } },
        statusBadge(user.status),
        user.status === 'active' && React.createElement('span', { className: 'badge badge-purple' }, planLabel[user.plan] || user.plan)
      )
    ),

    // Stats
    React.createElement('div', { className: 'stats-grid' },
      React.createElement('div', { className: 'stat-card' },
        React.createElement('div', { className: 'stat-value' }, hosts.length),
        React.createElement('div', { className: 'stat-label' }, 'Hostnames')
      ),
      React.createElement('div', { className: 'stat-card' },
        React.createElement('div', { className: 'stat-value' }, user.maxHosts || 0),
        React.createElement('div', { className: 'stat-label' }, 'Hostname limit')
      ),
      React.createElement('div', { className: 'stat-card' },
        React.createElement('div', { className: 'stat-value' }, hosts.filter(h => h.ip_address).length),
        React.createElement('div', { className: 'stat-label' }, 'Active IPs')
      ),
    ),

    // Tabs
    React.createElement('div', { style: { display: 'flex', gap: 4, marginBottom: 24, borderBottom: '1px solid var(--border)' } },
      ['hosts', 'billing'].map(t => React.createElement('button', {
        key: t, onClick: () => setTab(t),
        style: {
          padding: '10px 20px', background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 14, fontWeight: 500, fontFamily: 'Inter, sans-serif',
          color: tab === t ? 'var(--text)' : 'var(--text2)',
          borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
          marginBottom: -1,
        }
      }, t.charAt(0).toUpperCase() + t.slice(1)))
    ),

    // Hosts tab
    tab === 'hosts' && React.createElement('div', null,
      React.createElement('div', { className: 'flex-between mb-4' },
        React.createElement('h2', { className: 'section-title', style: { margin: 0 } }, 'Your hostnames'),
        user.status === 'active' && React.createElement('button', { className: 'btn btn-primary btn-sm', onClick: () => setShowAdd(true) }, '+ Add hostname')
      ),

      user.status !== 'active' && React.createElement(Alert, { type: 'info' },
        'Subscribe to start creating hostnames. ',
        React.createElement('a', { href: '#', onClick: (e) => { e.preventDefault(); setTab('billing'); }, style: { color: 'var(--accent2)' } }, 'View plans →')
      ),

      hosts.length === 0
        ? React.createElement('div', { className: 'card', style: { textAlign: 'center', padding: 48 } },
          React.createElement('div', { style: { fontSize: 40, marginBottom: 12 } }, '🌐'),
          React.createElement('h3', { style: { marginBottom: 8 } }, 'No hostnames yet'),
          React.createElement('p', { style: { color: 'var(--text2)', fontSize: 14 } }, user.status === 'active' ? 'Add your first hostname to get started.' : 'Subscribe first, then add hostnames.'),
          user.status === 'active' && React.createElement('button', { className: 'btn btn-primary mt-3', onClick: () => setShowAdd(true) }, '+ Add hostname')
        )
        : React.createElement('div', { className: 'card', style: { padding: 0, overflowX: 'auto' } },
          React.createElement('table', { className: 'host-table' },
            React.createElement('thead', null,
              React.createElement('tr', null,
                React.createElement('th', null, 'Hostname'),
                React.createElement('th', null, 'Current IP'),
                React.createElement('th', null, 'Update URL / Key'),
                React.createElement('th', null, 'Actions'),
              )
            ),
            React.createElement('tbody', null,
              hosts.map(h => React.createElement(HostRow, { key: h.id, host: h, onDelete: onHostDeleted, onRegenKey }))
            )
          )
        )
    ),

    // Billing tab
    tab === 'billing' && React.createElement('div', null,
      user.status === 'active' ? React.createElement('div', null,
        React.createElement('div', { className: 'card mb-4' },
          React.createElement('div', { className: 'flex-between' },
            React.createElement('div', null,
              React.createElement('h3', { style: { marginBottom: 4 } }, `${planLabel[user.plan]} plan`),
              React.createElement('p', { style: { color: 'var(--text2)', fontSize: 14 } }, `Up to ${user.maxHosts} hostnames`),
              user.planExpiresAt && React.createElement('p', { style: { color: 'var(--text3)', fontSize: 13, marginTop: 4 } }, `Renews ${new Date(user.planExpiresAt).toLocaleDateString()}`)
            ),
            React.createElement('div', { style: { display: 'flex', gap: 8 } },
              React.createElement('button', { className: 'btn btn-secondary', onClick: handlePortal, disabled: portalLoading },
                portalLoading ? React.createElement(Spinner) : 'Manage billing'
              )
            )
          )
        )
      ) : React.createElement('div', null,
        React.createElement('h2', { className: 'section-title' }, 'Choose a plan'),
        React.createElement('div', { className: 'pricing-grid' },
          plans.map(p => React.createElement('div', { key: p.key, className: 'pricing-card' },
            React.createElement('h3', { style: { color: 'var(--text2)', fontSize: 13, textTransform: 'uppercase', letterSpacing: 1 } }, p.label),
            React.createElement('div', { className: 'price-amount' }, p.amount.split('/')[0]),
            React.createElement('div', { className: 'price-period' }, '/' + p.amount.split('/')[1]),
            React.createElement('ul', { className: 'price-features' },
              React.createElement('li', null, `Up to ${p.maxHosts} hostnames`),
              React.createElement('li', null, 'IPv4 + IPv6'),
              React.createElement('li', null, 'DynDNS compatible'),
            ),
            React.createElement('button', {
              className: 'btn btn-primary w-full',
              onClick: () => handleCheckout(p.key),
              disabled: !!checkoutLoading,
            }, checkoutLoading === p.key ? React.createElement(Spinner) : 'Subscribe')
          ))
        )
      )
    ),

    showAdd && React.createElement(AddHostModal, { onClose: () => setShowAdd(false), onCreated: onHostCreated })
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
function App() {
  const { path, navigate } = useRoute();
  const auth = useAuth();

  window.navigate = navigate;

  if (auth.loading) return React.createElement('div', { className: 'flex-center', style: { minHeight: '100vh' } }, React.createElement(Spinner));

  // Protect dashboard
  if (path === '/dashboard' && !auth.user) {
    navigate('/login');
    return null;
  }

  // Redirect logged-in users from auth pages
  if ((path === '/login' || path === '/register') && auth.user) {
    navigate('/dashboard');
    return null;
  }

  return React.createElement('div', null,
    React.createElement(Nav, { user: auth.user, logout: auth.logout, navigate }),
    path === '/' && React.createElement(Landing, { navigate }),
    path === '/login' && React.createElement(LoginPage, { login: auth.login, navigate }),
    path === '/register' && React.createElement(RegisterPage, { register: auth.register, navigate }),
    path === '/dashboard' && auth.user && React.createElement(Dashboard, { user: auth.user, navigate, refreshUser: auth.refreshUser }),
    path === '/pricing' && React.createElement(Landing, { navigate }),
    !['/','  /login','/register','/dashboard','/pricing'].includes(path) &&
      React.createElement('div', { className: 'flex-center', style: { minHeight: 400, flexDirection: 'column', gap: 16 } },
        React.createElement('h1', null, '404'),
        React.createElement('p', { style: { color: 'var(--text2)' } }, 'Page not found'),
        React.createElement('button', { className: 'btn btn-primary', onClick: () => navigate('/') }, 'Go home')
      )
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
