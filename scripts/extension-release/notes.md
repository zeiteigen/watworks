Signed Chrome extension (CRX3), unpacked ZIP, and SHA-256 checksums.

- **Linux:** download the `.crx` and install it through your browser's supported extension installation flow.
- **Windows/macOS developer install:** extract the `.zip`, enable Developer mode at `chrome://extensions`, choose **Load unpacked**, and select the folder containing `manifest.json`. Chrome normally requires Web Store distribution for packed extensions on these platforms.
- Run `bun run setup` in an updated workspace to install the matching native startup helper. An extension download alone does not install the local workspace.

This release uses extension ID `onlcepldlajaajfjldnbipkbffaficjh`. Users of the previous unpacked ID `gjnfhbkemeoaoflhpbbicnpigekleimj` must update their workspace, reinstall the extension, and sign in/configure settings again. The local `data/` workspace stays in place. Remove the old extension after installing the new one, and restart the local workspace/MCP service when no application is active.

The private signing key is not included in any download.
