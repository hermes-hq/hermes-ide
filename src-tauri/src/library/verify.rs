//! Authenticity of a downloaded catalog: the manifest's minisign signature.
//!
//! Integrity comes from the hash chain (every object is named by its
//! sha256); authenticity from one signature over `manifest.json`, published
//! next to it as `manifest.json.minisig`, checked against the public keys
//! compiled into this build. No valid signature means nothing is applied.
//!
//! `TRUSTED_KEYS` is empty until hermes-hq/hodios publishes its release key
//! (plan prerequisite P1): until then every downloaded catalog is refused,
//! and the library stays on the catalog bundled with the app.

use minisign_verify::{PublicKey, Signature};

/// minisign public keys (base64 lines of `minisign.pub`) the library trusts.
/// A rotation adds the next key here one release before it signs.
pub const TRUSTED_KEYS: &[&str] = &[];

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
    /// No key is trusted yet (the catalog is not signed upstream).
    NoTrustedKey,
    /// The signature file is missing or unreadable.
    Missing(String),
    /// No trusted key verifies it.
    Invalid,
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VerifyError::NoTrustedKey => write!(
                f,
                "the library catalog is not signed with a key this Hermes trusts yet"
            ),
            VerifyError::Missing(e) => write!(f, "the catalog has no readable signature ({e})"),
            VerifyError::Invalid => write!(f, "the catalog signature did not verify"),
        }
    }
}

/// Verifies `manifest` against `signature` (the text of a `.minisig` file)
/// with any of `keys`. Prehashed (BLAKE2b) signatures only, as minisign
/// makes by default.
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
    let text = signature.ok_or_else(|| VerifyError::Missing("not published".into()))?;
    let sig = Signature::decode(text).map_err(|e| VerifyError::Missing(e.to_string()))?;
    if parsed
        .iter()
        .any(|k| k.verify(manifest, &sig, false).is_ok())
    {
        Ok(())
    } else {
        Err(VerifyError::Invalid)
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A throwaway key (seed 0x07 * 32, key id 0102030405060708) and its
    /// signature of `b"hello manifest"`, made with Node's ed25519 + BLAKE2b.
    pub const TEST_PUBKEY: &str = "RWQBAgMEBQYHCOpKbGPinFIKvvVQexMuxfmVR3auvr57kkIe6mkURtIs";
    pub const TEST_SIG: &str = "untrusted comment: signature from hodios test key\nRUQBAgMEBQYHCC9mCu3QQuBPopwQqiE2PFS6so1O5R0Ql3y+BvkZ+F0cpmkqNp67ntmrAgtWmD95I8xldKxuVU/51cffLfGeKQs=\ntrusted comment: timestamp:1759000000\tfile:manifest.json\nGNNfI3CoE6NsjHAvDpQ+77Lq2jm1mWy8RuSg22DPzF/nAjax7XxPZ1kIzxP1CX6kWKAxU/Gqh4072oT+BnnVAQ==\n";
    /// Another valid key that did not sign anything here.
    const OTHER_PUBKEY: &str = "RWQBAgMEBQYHCOpKbGPinFIKvvVQexMuxfmVR3auvr57kkIe6mkURtIt";

    #[test]
    fn accepts_a_good_signature() {
        assert_eq!(
            verify_manifest(b"hello manifest", Some(TEST_SIG), &[TEST_PUBKEY.into()]),
            Ok(())
        );
    }

    #[test]
    fn refuses_changed_bytes() {
        assert_eq!(
            verify_manifest(b"hello manifesT", Some(TEST_SIG), &[TEST_PUBKEY.into()]),
            Err(VerifyError::Invalid)
        );
    }

    #[test]
    fn refuses_a_missing_or_garbled_signature() {
        assert!(matches!(
            verify_manifest(b"hello manifest", None, &[TEST_PUBKEY.into()]),
            Err(VerifyError::Missing(_))
        ));
        assert!(matches!(
            verify_manifest(b"hello manifest", Some("nonsense"), &[TEST_PUBKEY.into()]),
            Err(VerifyError::Missing(_))
        ));
    }

    #[test]
    fn refuses_everything_without_a_trusted_key() {
        assert_eq!(
            verify_manifest(b"hello manifest", Some(TEST_SIG), &[]),
            Err(VerifyError::NoTrustedKey)
        );
        // Production builds trust no key until hodios signs its catalog.
        assert!(
            TRUSTED_KEYS.is_empty()
                || TRUSTED_KEYS
                    .iter()
                    .all(|k| PublicKey::from_base64(k).is_ok())
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
        assert!(
            verify_manifest(b"hello manifest", Some(TEST_SIG), &[OTHER_PUBKEY.into()]).is_err()
        );
    }
}
