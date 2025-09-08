# TabGroupsPlus

Add Tab Group related features to Chrome and Chromium-based web browsers (e.g. Brave) with this extension

1. Auto-collapses any expanded tab groups in the window that don't contain the window's active tab when...
    - the mouse cursor enters the content area of the active tab †
    - the active tab is moved to a different group

2. Auto-aligns the group containing the active tab to the leftmost / rightmost side of the tab bar.  When the group is no longer active and is therefore collapsed, TGP restores its old position (maintaining the original order of your tab groups in the window) _(optional)_

3. Auto-groups new tabs into the currently active tab's group _(optional)_

† Due to security limitations for extensions, the auto-collapsing when activating system tabs (such as those showing browser settings, the blank tab page, etc) occurs a short time after activating them.

## Installation

If you want to download the extension from the [GitHub repo](https://github.com/BenKennish/TabGroupsPlus/),
download it from the [Releases page](https://github.com/BenKennish/TabGroupsPlus/releases), extract the source code
zip/tar.gz into a folder somewhere on your device and then, using your browser's "Extensions" section, enable Developer Mode,
and use Load Unpacked extension pointing it to the folder.