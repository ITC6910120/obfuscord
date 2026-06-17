/**
 * Self-signed Root Certificate Authority + per-domain cert generation.
 *
 * Generates an in-memory CA at startup, then issues short-lived
 * certificates for target domains on demand (signed by the CA).
 * Chromium accepts these certs via the `certificate-error` Electron event.
 *
 * This allows our proxy to terminate Chromium's TLS (MITM) while creating
 * a separate, obfuscated TLS connection to the real server.
 */

import forge from 'node-forge'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CertBundle {
  key: string  // PEM-encoded private key
  cert: string // PEM-encoded certificate
}

// ---------------------------------------------------------------------------
// Verbose logging
// ---------------------------------------------------------------------------

let verbose = false

/** Enable or disable verbose CA logging (disabled by default). */
export function setVerbose(v: boolean): void {
  verbose = v
}

// ---------------------------------------------------------------------------
// Root CA
// ---------------------------------------------------------------------------

const CA_COMMON_NAME = 'Discord Obfuscated Proxy CA'

interface CaContext {
  key: forge.pki.PrivateKey
  cert: forge.pki.Certificate
}

let caContext: CaContext | null = null

/**
 * Initialises the in-memory Root CA.
 * Generates a 2048-bit RSA key pair + self-signed X.509 certificate.
 * Called once at startup.
 */
export function initCa(): void {
  if (caContext) return // Already initialised

  if (verbose) console.log('[CA] Generating Root CA key pair (2048-bit RSA)...')

  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()

  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'

  // Valid for 10 years from now
  const now = new Date()
  cert.validity.notBefore = now
  cert.validity.notAfter = new Date(now)
  cert.validity.notAfter.setFullYear(now.getFullYear() + 10)

  // Subject = Issuer (self-signed)
  const attrs = [{ name: 'commonName', value: CA_COMMON_NAME }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)

  // CA extensions
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier' },
  ])

  cert.sign(keys.privateKey, forge.md.sha256.create())

  caContext = { key: keys.privateKey, cert }

  if (verbose) console.log('[CA] Root CA ready —', CA_COMMON_NAME)
}

/**
 * Returns the Root CA's common name (for certificate-error matching).
 */
export function getCaName(): string {
  return CA_COMMON_NAME
}

// ---------------------------------------------------------------------------
// Per-domain certificate cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  bundle: CertBundle
  expires: Date
}

const certCache = new Map<string, CacheEntry>()

const CERT_TTL_MS = 60 * 60 * 1000 // 1 hour

/**
 * Returns (or generates & caches) a certificate + key for the given domain,
 * signed by the Root CA.
 */
export function signCert(domain: string): CertBundle {
  // Check cache
  const cached = certCache.get(domain)
  if (cached && cached.expires > new Date()) {
    return cached.bundle
  }

  // Generate key pair and certificate
  if (verbose) console.log('[CA] Signing cert for', domain)

  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()

  cert.publicKey = keys.publicKey
  cert.serialNumber = Date.now().toString(16) // Unique hex serial

  // Valid for CERT_TTL
  const now = new Date()
  cert.validity.notBefore = now
  cert.validity.notAfter = new Date(now.getTime() + CERT_TTL_MS)

  // Subject = domain
  cert.setSubject([{ name: 'commonName', value: domain }])

  // Issuer = Root CA
  cert.setIssuer(caContext!.cert.subject.attributes)

  // End-entity certificate extensions
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [{ type: 2, value: domain }], // type 2 = DNS
    },
  ])

  cert.sign(caContext!.key, forge.md.sha256.create())

  const bundle: CertBundle = {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  }

  // Cache
  certCache.set(domain, { bundle, expires: cert.validity.notAfter })

  return bundle
}
