// Tab Groups Plus
// shared.js
//   a module of stuff that's shared between background.js, content.js, and/or options.js

// constant object to fake an 'enum'
// the numbers for LEFT and RIGHT conveniently match the tab index locations
// to move the active group to (start and end respectively)
export const ALIGN = Object.freeze({
    LEFT: 0,
    RIGHT: -1,
    DISABLED: 42
});

// constant object to fake an 'enum' for the types of auto-grouping patterns
export const AUTO_GROUP_PATTERN_TYPE = Object.freeze({
    DOMAINNAME: 0,
    REGEXP: 1
});

export const DEFAULT_OPTIONS = Object.freeze({

    // do we perform a compact operation when the active tab is not in a group?
    compactOnActivateUngroupedTab: true,

    // only applies when compactOnActivateUngroupedTab is true
    // if false, the previously active group will not be collapsed (remain expanded)
    collapsePreviousActiveGroupOnActivateUngroupedTab: false,

    // valid values ALIGN.LEFT, ALIGN.RIGHT, or ALIGN.DISABLED
    alignActiveTabGroup: ALIGN.DISABLED,

    // upon creating a new tab (which gets activated)
    // do we auto group it into the same group as the previously active tab?
    autoGroupNewTabs: true,

    // time to wait after mouse cursor entering an injected tab's content area
    // before compacting the other tab groups in the window
    delayCompactOnEnterContentAreaMs: 250,

    // time to wait after activating a tab that doesn't have our content script injected
    // (e.g. a system tab) before compacting the other tab groups in the window
    delayCompactOnActivateUninjectedTabMs: 3000,

    // temporary example rules : map URL patterns to tab group names
    /*
    tabAutoGroupRules: [
        {
            urlSearchType: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME,
            urlSearchPatterns: ['guildwars2.com'],
            tabGroupTitle: 'Guild Wars 2 🐲'
        },
        {
            urlSearchType: AUTO_GROUP_PATTERN_TYPE.REGEXP,
            urlSearchPatterns: ['^https?://([^/]+)/\\?test=autogroup'],
            tabGroupTitle: 'Testing',
            regexpCompiled: null
        },
        {
            urlSearchType: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME,
            urlSearchPatterns: ['youtube.com', 'twitch.tv', 'netflix.com' ],
            tabGroupTitle: 'Streaming 📺',
        }
    ],
    */

    autoGroupingEnabled: true,
    autoGroupingCanCreateGroups: true,
    autoGroupingCanOpenGroups: true,

    magicAutoGroupingEnabled: false, //unimplemented

    autoGroupRules: {
        'Streaming 📺':
            [
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'youtube.com' },
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'twitch.tv' },
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'netflix.com' }
            ],
        'Guild Wars 2 🐲':
            [
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'guildwars2.com' }
            ],
        'Testing':
            [
                // any URL where the first GET param is "test=autogroup" gets put in the tab group called "Testing"
                { type: AUTO_GROUP_PATTERN_TYPE.REGEXP, pattern: '^https?://([^/]+)/\\?test=autogroup', regexpCompiled: null }
            ],
        'Shopping 🛒':
            [
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'amazon.co.uk' },
            ],
        'SHARED':
            [
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'mail.google.com' },
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'calendar.google.com' }
            ],
        'AI 🧠':
            [
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'gemini.google.com' },
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'perplexity.ai' },
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'chatgpt.com' }
            ]
    }

    // TODO: auto grouping should take precedence over magic autogrouping

});

// we use this prefix rather than defining a new wrapper function around console.log etc
// because it makes tracking errors down easier w.r.t line numbers
export const CONSOLE_PREFIX = "[TGP]";
