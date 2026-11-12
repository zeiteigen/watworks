Signed Chrome extension (CRX3), unpacked ZIP, and SHA-256 checksums.

- **Linux:** download the `.crx` and install it through your browser's supported extension installation flow.
- **Windows/macOS developer install:** extract the `.zip`, enable Developer mode at `chrome://extensions`, choose **Load unpacked**, and select the folder containing `manifest.json`. Chrome normally requires Web Store distribution for packed extensions on these platforms.
- **Hosted workspace:** sign in to WaterlooWorks and choose **Open dashboard** from the extension. Hosted access requires an Insider grant. No local setup is needed.
- **Advanced local workspace:** run `bun run setup` in an updated checkout to install the matching native startup helper. An extension download alone does not install the local workspace.
- **Updates:** unpacked installs do not update automatically. Replace the installed files with the new ZIP contents and reload the extension after any application operation finishes.

This release uses extension ID `onlcepldlajaajfjldnbipkbffaficjh`. Users of the previous unpacked ID `gjnfhbkemeoaoflhpbbicnpigekleimj` must update their workspace, reinstall the extension, and sign in/configure settings again. The local `data/` workspace stays in place. Remove the old extension after installing the new one, and restart the local workspace/MCP service when no application is active.

The private signing key is not included in any download.
