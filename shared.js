// Tab Groups Plus
// module of stuff that's shared between background.js, content.js, and/or options.js

// constant object to fake an 'enum'
// the numbers for LEFT and RIGHT conveniently match the tab index locations
// to move the active group to (start and end respectively)
export const ALIGN = Object.freeze({
    LEFT: 0,
    RIGHT: -1,
    DISABLED: 666
});

export const DEFAULT_OPTIONS = Object.freeze({

    // do we perform a collapse operation when the active tab is not in a group?
    collapseOthersWithGrouplessTab: true,

    // valid values ALIGN.LEFT, ALIGN.RIGHT, or ALIGN.DISABLED
    alignActiveTabGroup: ALIGN.LEFT,

    // time to wait after mouse cursor entering a tab's content area before collapsing the other tab groups in the window
    collapseDelayOnEnterContentAreaMs: 2000,

    // time to wait after activating a tab that doesn't have our content script injected before collapsing the other tab groups in the window
    collapseDelayOnActivateUninjectedTabMs: 4000,

    // do we auto group new tabs into the same group as the previously active tab?
    autoGroupNewTabs: true
});

export const CONSOLE_PREFIX = "[TabGroupsPlus] ";

