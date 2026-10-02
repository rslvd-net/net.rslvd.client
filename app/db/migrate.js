const pool = require('./pool');

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  square_customer_id VARCHAR(255),
  square_card_id VARCHAR(255),
  subscription_id VARCHAR(255),
  subscription_status VARCHAR(50) DEFAULT 'inactive',
  plan VARCHAR(50) DEFAULT 'free',
  plan_expires_at TIMESTAMPTZ,
  max_hosts INTEGER DEFAULT 1,
  max_tunnels INTEGER DEFAULT 1,
  is_admin BOOLEAN DEFAULT FALSE,
  is_site_owner BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hosts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  hostname VARCHAR(255) NOT NULL,
  parent_host_id UUID REFERENCES hosts(id) ON DELETE CASCADE,
  fqdn VARCHAR(255) UNIQUE NOT NULL,
  ip_address INET,
  ipv6_address INET,
  ionos_record_id_v4 VARCHAR(255),
  ionos_record_id_v6 VARCHAR(255),
  last_updated TIMESTAMPTZ,
  update_key VARCHAR(255) UNIQUE NOT NULL,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tunnels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(63) NOT NULL,
  tunnel_port INTEGER UNIQUE NOT NULL,
  target_host VARCHAR(255) NOT NULL DEFAULT 'localhost',
  target_port INTEGER NOT NULL,
  protocol VARCHAR(10) DEFAULT 'tcp',
  wg_public_key VARCHAR(255),
  wg_preshared_key VARCHAR(255),
  wg_client_ip VARCHAR(45),
  wg_server_port INTEGER,
  status VARCHAR(20) DEFAULT 'pending',
  fqdn VARCHAR(255),
  ionos_record_id VARCHAR(255),
  token VARCHAR(255) UNIQUE NOT NULL,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS update_logs (
  id BIGSERIAL PRIMARY KEY,
  host_id UUID REFERENCES hosts(id) ON DELETE CASCADE,
  ip_address INET,
  user_agent TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hosts_user_id ON hosts(user_id);
CREATE INDEX IF NOT EXISTS idx_hosts_fqdn ON hosts(fqdn);
CREATE INDEX IF NOT EXISTS idx_hosts_update_key ON hosts(update_key);
CREATE INDEX IF NOT EXISTS idx_tunnels_user_id ON tunnels(user_id);
CREATE INDEX IF NOT EXISTS idx_tunnels_token ON tunnels(token);
CREATE INDEX IF NOT EXISTS idx_update_logs_host_id ON update_logs(host_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS max_tunnels INTEGER DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_site_owner BOOLEAN DEFAULT FALSE;
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS parent_host_id UUID REFERENCES hosts(id) ON DELETE CASCADE;
ALTER TABLE hosts ALTER COLUMN hostname TYPE VARCHAR(255);
ALTER TABLE tunnels ADD COLUMN IF NOT EXISTS parent_tunnel_id UUID REFERENCES tunnels(id) ON DELETE CASCADE;
ALTER TABLE tunnels ALTER COLUMN name TYPE VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_secret VARCHAR(64);
ALTER TABLE users ALTER COLUMN plan SET DEFAULT 'free';
ALTER TABLE users ALTER COLUMN max_hosts SET DEFAULT 1;
UPDATE users SET plan = 'free', max_hosts = 1, max_tunnels = 1 WHERE plan = 'none' AND subscription_status = 'inactive';

ALTER TABLE hosts ADD COLUMN IF NOT EXISTS force_https BOOLEAN DEFAULT TRUE;
ALTER TABLE tunnels ADD COLUMN IF NOT EXISTS force_https BOOLEAN DEFAULT TRUE;


CREATE TABLE IF NOT EXISTS reserved_subdomains (
  id SERIAL PRIMARY KEY,
  subdomain VARCHAR(63) UNIQUE NOT NULL,
  reason VARCHAR(255),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reserved_subdomain ON reserved_subdomains(subdomain);

CREATE TABLE IF NOT EXISTS activity_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event VARCHAR(64) NOT NULL,
  detail TEXT,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user ON activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_event ON activity_logs(event);

INSERT INTO reserved_subdomains (subdomain, reason) VALUES
  ('www',       'Standard web root'),
  ('ww2',       'Secondary web'),
  ('mail',      'Mail server'),
  ('smtp',      'SMTP relay'),
  ('pop',       'POP3 mail'),
  ('pop3',      'POP3 mail'),
  ('imap',      'IMAP mail'),
  ('mx',        'Mail exchanger'),
  ('mx1',       'Primary MX'),
  ('mx2',       'Secondary MX'),
  ('ns',        'Name server'),
  ('ns1',       'Primary nameserver'),
  ('ns2',       'Secondary nameserver'),
  ('ns3',       'Tertiary nameserver'),
  ('ns4',       'Quaternary nameserver'),
  ('dns',       'DNS service'),
  ('ftp',       'FTP server'),
  ('sftp',      'SFTP server'),
  ('api',       'API endpoint'),
  ('app',       'Application'),
  ('apps',      'Applications'),
  ('admin',     'Admin panel'),
  ('dashboard', 'Dashboard'),
  ('portal',    'Portal'),
  ('panel',     'Control panel'),
  ('cpanel',    'cPanel hosting'),
  ('webmail',   'Webmail'),
  ('static',    'Static assets'),
  ('assets',    'Assets CDN'),
  ('cdn',       'CDN'),
  ('dl',        'Downloads'),
  ('download',  'Downloads'),
  ('downloads', 'Downloads'),
  ('files',     'File hosting'),
  ('media',     'Media server'),
  ('img',       'Images'),
  ('images',    'Images'),
  ('upload',    'Uploads'),
  ('uploads',   'Uploads'),
  ('vpn',       'VPN server'),
  ('proxy',     'Proxy server'),
  ('git',       'Git server'),
  ('ssh',       'SSH jump host'),
  ('monitor',   'Monitoring'),
  ('status',    'Status page'),
  ('health',    'Health check'),
  ('blog',      'Blog'),
  ('shop',      'Shop/Store'),
  ('store',     'Store'),
  ('dev',       'Development'),
  ('staging',   'Staging environment'),
  ('test',      'Test environment'),
  ('prod',      'Production'),
  ('beta',      'Beta'),
  ('alpha',     'Alpha'),
  ('demo',      'Demo'),
  ('docs',      'Documentation'),
  ('help',      'Help/Support'),
  ('support',   'Support'),
  ('forum',     'Forum'),
  ('chat',      'Chat'),
  ('rslvd',     'Service name'),
  ('internal',  'Internal use'),
  ('intranet',  'Intranet'),
  ('localhost',  'Reserved'),
  ('server',    'Server'),
  ('home',      'Home'),
  ('router',    'Router'),
  ('gateway',   'Gateway'),
  ('firewall',  'Firewall'),
  ('backup',    'Backup'),
  ('noc',       'Network ops'),
  ('sip',       'SIP/VoIP'),
  ('voip',      'VoIP'),
  ('tv',        'Media/TV'),
  ('cam',       'Camera'),
  ('cams',      'Cameras'),
  ('wss',       'WebSocket'),
  ('ws',        'WebSocket'),
  ('autoconfig','Email autoconfig'),
  ('autodiscover','Email autodiscover')
ON CONFLICT (subdomain) DO NOTHING;

DROP TABLE IF EXISTS email_accounts;
DROP TABLE IF EXISTS parked_messages;
DROP TABLE IF EXISTS parked_emails;

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_expires TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tos_version_accepted VARCHAR(50);

ALTER TABLE users ADD COLUMN IF NOT EXISTS square_customer_id VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS square_card_id VARCHAR(255);
ALTER TABLE users DROP COLUMN IF EXISTS stripe_customer_id;
ALTER TABLE users DROP COLUMN IF EXISTS braintree_customer_id;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token ON password_reset_tokens(token);

CREATE TABLE IF NOT EXISTS payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  plan VARCHAR(50) NOT NULL,
  kind VARCHAR(20) NOT NULL DEFAULT 'subscribe',
  amount_cents INTEGER NOT NULL,
  square_customer_id VARCHAR(255),
  square_card_id VARCHAR(255),
  square_payment_id VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_intents_status ON payment_intents(status);

ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_hosts INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_tunnels INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS donated_total_cents INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS support_tickets (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS ticket_messages (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  is_staff BOOLEAN NOT NULL DEFAULT FALSE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id);
ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS is_ai BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS dns_changes (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  host_id UUID REFERENCES hosts(id) ON DELETE SET NULL,
  tunnel_id UUID REFERENCES tunnels(id) ON DELETE SET NULL,
  fqdn VARCHAR(255) NOT NULL,
  record_type VARCHAR(10),
  change VARCHAR(30) NOT NULL,
  old_value TEXT,
  new_value TEXT,
  source VARCHAR(30),
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dns_changes_user ON dns_changes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dns_changes_host ON dns_changes(host_id);
CREATE INDEX IF NOT EXISTS idx_dns_changes_tunnel ON dns_changes(tunnel_id);

ALTER TABLE tunnels ADD COLUMN IF NOT EXISTS device_lock BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tunnels ADD COLUMN IF NOT EXISTS bound_device VARCHAR(128);
ALTER TABLE tunnels ADD COLUMN IF NOT EXISTS bound_device_name VARCHAR(100);
ALTER TABLE tunnels ADD COLUMN IF NOT EXISTS bound_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS beta_testers (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

async function run() {
  try {
    await pool.query(schema);
    console.log('Database schema up to date');
  } catch (err) {
    console.error('Migration error:', err);
  }
}

module.exports = { run };
