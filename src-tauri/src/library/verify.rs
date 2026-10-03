//! Authenticity of a downloaded catalog: the manifest's minisign signature.
//!
//! Integrity comes from the hash chain (every object is named by its
//! sha256); authenticity from one signature over `manifest.json`, published
//! next to it as `manifest.json.minisig`, checked against the public keys
//! compiled into this build. No valid signature means nothing is applied.
//!
//! Format: minisign, prehashed Ed25519 (Ed25519 over the BLAKE2b-512 of the
//! exact manifest bytes). Line 2 of the signature names the 8-byte key id,
//! so a rotation can trust two keys for a while. hermes-hq/hodios signs in
//! its release workflow (`tools/release/manifest-signing.mjs`); the key is
//! `keys/manifest-signing.pub` there.

use base64::Engine;
use minisign_verify::{PublicKey, Signature};

/// minisign public keys (base64 lines of `minisign.pub`) the library trusts.
/// A rotation adds the next key here one release before it signs.
pub const TRUSTED_KEYS: &[&str] = &[
    // hermes-hq/hodios keys/manifest-signing.pub, key id A531B1E7D5AC2351.
    "RWRRI6zV57ExpT6tnunPYLEdTM/SjnlUpeO3v3gX/v3sHGiefCEWO+VI",
];

/// Test builds only: one more key from `HERMES_E2E_LIBRARY_PUBKEY`, so the
/// real-app scenarios can serve a catalog signed with a throwaway key. The
/// e2e feature refuses to compile in a release build.
pub fn trusted_keys() -> Vec<String> {
    #[allow(unused_mut)]
    let mut keys: Vec<String> = TRUSTED_KEYS.iter().map(|k| k.to_string()).collect();
    #[cfg(feature = "e2e")]
    if let Ok(k) = std::env::var("HERMES_E2E_LIBRARY_PUBKEY") {
        if !k.trim().is_empty() {
            keys.push(k.trim().to_string());
        }
    }
    keys
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyError {
    /// No key is trusted (a build without `TRUSTED_KEYS`).
    NoTrustedKey,
    /// The mirror publishes no signature: the catalog has not had a signed
    /// release yet. Not an attack by itself, but nothing is applied.
    NotPublished,
    /// A signature file is there but is not a minisign signature this
    /// build accepts (garbled, or not prehashed).
    Malformed(String),
    /// Signed with a key this build does not trust (its key id).
    UnknownKey(String),
    /// Signed with a trusted key, but not over these bytes.
    Invalid,
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VerifyError::NoTrustedKey => write!(
                f,
                "this Hermes build trusts no library signing key, so it cannot take catalog updates"
            ),
            VerifyError::NotPublished => write!(
                f,
                "the library catalog has no signed release yet; staying on the catalog this Hermes has"
            ),
            VerifyError::Malformed(e) => write!(f, "the catalog signature is unreadable ({e})"),
            VerifyError::UnknownKey(id) => write!(
                f,
                "the catalog is signed with key {id}, which this Hermes does not trust"
            ),
            VerifyError::Invalid => write!(
                f,
                "the catalog signature does not match its contents; it was altered after signing"
            ),
        }
    }
}

/// The key id a minisign signature names, as minisign prints it.
fn signature_key_id(text: &str) -> Option<String> {
    let line = text.lines().nth(1)?.trim();
    let bin = base64::engine::general_purpose::STANDARD
        .decode(line)
        .ok()?;
    let id = bin.get(2..10)?;
    Some(id.iter().rev().map(|b| format!("{b:02X}")).collect())
}

/// Verifies `manifest` against `signature` (the text of a `.minisig` file,
/// `None` when the mirror has none) with any of `keys`. Prehashed (BLAKE2b)
/// signatures only, as minisign makes by default.
pub fn verify_manifest(
    manifest: &[u8],
    signature: Option<&str>,
    keys: &[String],
) -> Result<(), VerifyError> {
    let parsed: Vec<PublicKey> = keys
        .iter()
        .filter_map(|k| PublicKey::from_base64(k).ok())
        .collect();
    if parsed.is_empty() {
        return Err(VerifyError::NoTrustedKey);
    }
    let text = signature.ok_or(VerifyError::NotPublished)?;
    let sig = Signature::decode(text).map_err(|e| VerifyError::Malformed(e.to_string()))?;
    let mut known_key = false;
    for k in &parsed {
        match k.verify(manifest, &sig, false) {
            Ok(()) => return Ok(()),
            Err(minisign_verify::Error::UnexpectedKeyId) => {}
            Err(minisign_verify::Error::UnexpectedAlgorithm) => {
                return Err(VerifyError::Malformed(
                    "not a prehashed minisign signature".into(),
                ))
            }
            Err(_) => known_key = true,
        }
    }
    if known_key {
        Err(VerifyError::Invalid)
    } else {
        Err(VerifyError::UnknownKey(
            signature_key_id(text).unwrap_or_else(|| "?".into()),
        ))
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    /// A throwaway key (seed 0x07 * 32, key id 0102030405060708) and its
    /// signature of `b"hello manifest"`, made with Node's ed25519 + BLAKE2b.
    pub const TEST_PUBKEY: &str = "RWQBAgMEBQYHCOpKbGPinFIKvvVQexMuxfmVR3auvr57kkIe6mkURtIs";
    pub const TEST_SIG: &str = "untrusted comment: signature from hodios test key\nRUQBAgMEBQYHCC9mCu3QQuBPopwQqiE2PFS6so1O5R0Ql3y+BvkZ+F0cpmkqNp67ntmrAgtWmD95I8xldKxuVU/51cffLfGeKQs=\ntrusted comment: timestamp:1759000000\tfile:manifest.json\nGNNfI3CoE6NsjHAvDpQ+77Lq2jm1mWy8RuSg22DPzF/nAjax7XxPZ1kIzxP1CX6kWKAxU/Gqh4072oT+BnnVAQ==\n";
    /// Another valid key that did not sign anything here.
    const OTHER_PUBKEY: &str = "RWQBAgMEBQYHCOpKbGPinFIKvvVQexMuxfmVR3auvr57kkIe6mkURtIt";

    // ─── A minisign signer for tests: a fresh key per test ─────────────

    /// BLAKE2b-512 (RFC 7693), for the minisign prehash.
    fn blake2b512(data: &[u8]) -> [u8; 64] {
        const IV: [u64; 8] = [
            0x6a09e667f3bcc908,
            0xbb67ae8584caa73b,
            0x3c6ef372fe94f82b,
            0xa54ff53a5f1d36f1,
            0x510e527fade682d1,
            0x9b05688c2b3e6c1f,
            0x1f83d9abfb41bd6b,
            0x5be0cd19137e2179,
        ];
        const SIGMA: [[usize; 16]; 10] = [
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
            [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
            [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
            [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
            [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
            [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
            [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
            [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
            [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
            [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
        ];
        fn g(v: &mut [u64; 16], [a, b, c, d]: [usize; 4], x: u64, y: u64) {
            v[a] = v[a].wrapping_add(v[b]).wrapping_add(x);
            v[d] = (v[d] ^ v[a]).rotate_right(32);
            v[c] = v[c].wrapping_add(v[d]);
            v[b] = (v[b] ^ v[c]).rotate_right(24);
            v[a] = v[a].wrapping_add(v[b]).wrapping_add(y);
            v[d] = (v[d] ^ v[a]).rotate_right(16);
            v[c] = v[c].wrapping_add(v[d]);
            v[b] = (v[b] ^ v[c]).rotate_right(63);
        }
        fn compress(h: &mut [u64; 8], block: &[u8], t: u128, last: bool) {
            let mut m = [0u64; 16];
            for (i, w) in m.iter_mut().enumerate() {
                *w = u64::from_le_bytes(block[i * 8..i * 8 + 8].try_into().unwrap());
            }
            let mut v = [0u64; 16];
            v[..8].copy_from_slice(h);
            v[8..].copy_from_slice(&IV);
            v[12] ^= t as u64;
            v[13] ^= (t >> 64) as u64;
            if last {
                v[14] = !v[14];
            }
            for r in 0..12 {
                let s = &SIGMA[r % 10];
                g(&mut v, [0, 4, 8, 12], m[s[0]], m[s[1]]);
                g(&mut v, [1, 5, 9, 13], m[s[2]], m[s[3]]);
                g(&mut v, [2, 6, 10, 14], m[s[4]], m[s[5]]);
                g(&mut v, [3, 7, 11, 15], m[s[6]], m[s[7]]);
                g(&mut v, [0, 5, 10, 15], m[s[8]], m[s[9]]);
                g(&mut v, [1, 6, 11, 12], m[s[10]], m[s[11]]);
                g(&mut v, [2, 7, 8, 13], m[s[12]], m[s[13]]);
                g(&mut v, [3, 4, 9, 14], m[s[14]], m[s[15]]);
            }
            for i in 0..8 {
                h[i] ^= v[i] ^ v[i + 8];
            }
        }
        let mut h = IV;
        h[0] ^= 0x0101_0000 ^ 64;
        let mut t: u128 = 0;
        let mut rest = data;
        while rest.len() > 128 {
            t += 128;
            compress(&mut h, &rest[..128], t, false);
            rest = &rest[128..];
        }
        let mut last = [0u8; 128];
        last[..rest.len()].copy_from_slice(rest);
        t += rest.len() as u128;
        compress(&mut h, &last, t, true);
        let mut out = [0u8; 64];
        for (i, w) in h.iter().enumerate() {
            out[i * 8..i * 8 + 8].copy_from_slice(&w.to_le_bytes());
        }
        out
    }

    /// A minisign key made for one test: `public` is the base64 line of
    /// its minisign.pub, `sign` makes a prehashed `.minisig` text.
    pub struct TestKey {
        pair: Ed25519KeyPair,
        keynum: [u8; 8],
        pub public: String,
    }

    impl TestKey {
        pub fn generate() -> TestKey {
            let rng = ring::rand::SystemRandom::new();
            let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
            let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
            let mut keynum = [0u8; 8];
            ring::rand::SecureRandom::fill(&rng, &mut keynum).unwrap();
            let mut pk = b"Ed".to_vec();
            pk.extend_from_slice(&keynum);
            pk.extend_from_slice(pair.public_key().as_ref());
            let public = base64::engine::general_purpose::STANDARD.encode(pk);
            TestKey {
                pair,
                keynum,
                public,
            }
        }

        pub fn key_id(&self) -> String {
            self.keynum
                .iter()
                .rev()
                .map(|b| format!("{b:02X}"))
                .collect()
        }

        pub fn sign(&self, data: &[u8]) -> String {
            let b64 = base64::engine::general_purpose::STANDARD;
            let sig = self.pair.sign(&blake2b512(data));
            let trusted = "timestamp:1759000000\tfile:manifest.json\thashed";
            let mut global_msg = sig.as_ref().to_vec();
            global_msg.extend_from_slice(trusted.as_bytes());
            let global = self.pair.sign(&global_msg);
            let mut line = b"ED".to_vec();
            line.extend_from_slice(&self.keynum);
            line.extend_from_slice(sig.as_ref());
            format!(
                "untrusted comment: signature from a test key\n{}\ntrusted comment: {trusted}\n{}\n",
                b64.encode(line),
                b64.encode(global.as_ref())
            )
        }
    }

    #[test]
    fn the_test_signer_matches_blake2b_and_minisign() {
        // RFC 7693 appendix A: BLAKE2b-512("abc") starts ba 80 a5 3f 98 1c 4d 0d.
        assert_eq!(
            blake2b512(b"abc")[..8],
            [0xba, 0x80, 0xa5, 0x3f, 0x98, 0x1c, 0x4d, 0x0d]
        );
        // Multi-block input, verified by the minisign-verify crate.
        let key = TestKey::generate();
        let long = vec![7u8; 1000];
        assert_eq!(
            verify_manifest(
                &long,
                Some(&key.sign(&long)),
                std::slice::from_ref(&key.public)
            ),
            Ok(())
        );
    }

    #[test]
    fn accepts_a_good_signature() {
        assert_eq!(
            verify_manifest(b"hello manifest", Some(TEST_SIG), &[TEST_PUBKEY.into()]),
            Ok(())
        );
        let key = TestKey::generate();
        let m = br#"{"schema":1,"catalog":"2026.1003.1","seq":7}"#;
        assert_eq!(
            verify_manifest(m, Some(&key.sign(m)), std::slice::from_ref(&key.public)),
            Ok(())
        );
    }

    #[test]
    fn refuses_changed_bytes() {
        assert_eq!(
            verify_manifest(b"hello manifesT", Some(TEST_SIG), &[TEST_PUBKEY.into()]),
            Err(VerifyError::Invalid)
        );
        let key = TestKey::generate();
        let sig = key.sign(b"the signed manifest");
        assert_eq!(
            verify_manifest(
                b"the altered manifest",
                Some(&sig),
                std::slice::from_ref(&key.public)
            ),
            Err(VerifyError::Invalid)
        );
        // An edited trusted comment breaks the global signature.
        let edited = sig.replace("file:manifest.json", "file:other.json");
        assert_eq!(
            verify_manifest(
                b"the signed manifest",
                Some(&edited),
                std::slice::from_ref(&key.public)
            ),
            Err(VerifyError::Invalid)
        );
    }

    #[test]
    fn refuses_a_missing_or_garbled_signature() {
        assert_eq!(
            verify_manifest(b"hello manifest", None, &[TEST_PUBKEY.into()]),
            Err(VerifyError::NotPublished)
        );
        assert!(matches!(
            verify_manifest(b"hello manifest", Some("nonsense"), &[TEST_PUBKEY.into()]),
            Err(VerifyError::Malformed(_))
        ));
    }

    #[test]
    fn refuses_a_legacy_signature() {
        // minisign -l (not prehashed): the algorithm bytes say "Ed".
        let key = TestKey::generate();
        let sig = key.sign(b"m");
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut lines: Vec<String> = sig.lines().map(String::from).collect();
        let mut bin = b64.decode(&lines[1]).unwrap();
        bin[1] = b'd';
        lines[1] = b64.encode(bin);
        assert!(matches!(
            verify_manifest(
                b"m",
                Some(&lines.join("\n")),
                std::slice::from_ref(&key.public)
            ),
            Err(VerifyError::Malformed(_))
        ));
    }

    #[test]
    fn names_an_unknown_key() {
        let signer = TestKey::generate();
        let trusted = TestKey::generate();
        let m = b"manifest";
        let e = verify_manifest(
            m,
            Some(&signer.sign(m)),
            std::slice::from_ref(&trusted.public),
        );
        assert_eq!(e, Err(VerifyError::UnknownKey(signer.key_id())));
        assert!(e.unwrap_err().to_string().contains(&signer.key_id()));
    }

    #[test]
    fn refuses_everything_without_a_trusted_key() {
        assert_eq!(
            verify_manifest(b"hello manifest", Some(TEST_SIG), &[]),
            Err(VerifyError::NoTrustedKey)
        );
    }

    #[test]
    fn production_trusts_the_hodios_release_key() {
        assert_eq!(TRUSTED_KEYS.len(), 1);
        for k in TRUSTED_KEYS {
            PublicKey::from_base64(k).expect("a minisign public key");
        }
        // The release key does not verify a test signature: it is not a test key.
        let keys: Vec<String> = TRUSTED_KEYS.iter().map(|k| k.to_string()).collect();
        assert_eq!(
            verify_manifest(b"hello manifest", Some(TEST_SIG), &keys),
            Err(VerifyError::UnknownKey("0807060504030201".into()))
        );
    }

    #[test]
    fn a_rotated_key_set_still_verifies() {
        assert_eq!(
            verify_manifest(
                b"hello manifest",
                Some(TEST_SIG),
                &[OTHER_PUBKEY.into(), TEST_PUBKEY.into()]
            ),
            Ok(())
        );
        // OTHER_PUBKEY has the same key id but another key: a forged signature.
        assert_eq!(
            verify_manifest(b"hello manifest", Some(TEST_SIG), &[OTHER_PUBKEY.into()]),
            Err(VerifyError::Invalid)
        );
    }
}
