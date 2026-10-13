# Hermes IDE 2.3.2

Terminal suggestions never offer a password, key or token back to you.

## Fixed

- What you type at a hidden password prompt (sudo, ssh, a script asking for a passphrase) is never remembered or suggested.
- Commands that hold a secret, such as setting an API key or token, passing a password, an auth header or a URL with a password in it, are never shown as a suggestion or as faded text after the cursor. Your shell's own history is not changed.
