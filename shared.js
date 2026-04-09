// Tab Groups Plus
// shared.js
//   a module of stuff that's shared between background.js and options.js

// we use this prefix rather than defining a new wrapper function around console.log etc
// because it makes tracking errors down easier w.r.t line numbers
export const CONSOLE_PREFIX = "[TGP]";

// constant objects to fake an 'enum's - not great because multiple properties can have the same value
// but it makes for more readable code and we can at least have a helper function to check if a value is a valid enum value (e.g. for validating user options)
//
// the numbers for LEFT and RIGHT conveniently match the tab index locations
// to move the active group to (start and end respectively)
export const ALIGN = Object.freeze({
    LEFT: 0,
    RIGHT: -1,
    DISABLED: 42
});
//
// types of auto-grouping patterns
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

    // how do we align the active tab group at the end of a compact operation
    // valid values are ALIGN.LEFT, ALIGN.RIGHT, or ALIGN.DISABLED
    alignActiveTabGroup: ALIGN.DISABLED,

    // upon creating a new tab in a window
    // do we place it into the group of the previously active tab of that window
    moveNewTabsToGroupOfLastActiveTabInWindow: true,

    // time to wait after mouse cursor entering an injected tab's content area
    // before compacting the other tab groups in the window
    delayCompactOnEnterContentAreaMs: 250,

    // time to wait after activating a tab that doesn't have our content script injected
    // (e.g. a system tab) before compacting the other tab groups in the window
    delayCompactOnActivateUninjectedTabMs: 3000,

    // is auto grouping enabled
    autoGroupingEnabled: true,

    // does auto grouping allow for grouping existing tabs (as opposed to just newly created ones)
    // this may be better as a per-rule setting
    // (e.g. user wants to autogroup whenever a tab (new or old) goes to wiki.guildwars2.com
    // but not autogroup existing tabs that navigate to youtube.com)
    autoGroupingChecksExistingTabs: true,

    // UNIMPLEMENTED
    // problematic as extensions cannot access Chrome's saved groups that are closed (that can sit on the bookmarks bar) so we might end up creating a new groups instead of reusing existing closed saved group
    //autoGroupingCanCreateGroups: true,
    // currently not possible to open any tab groups that are closed (but saved within saved groups)
    //autoGroupingCanOpenGroups: true,

    // UNIMPLEMENTED
    // the idea is that whenever the URL of a tab is updated, we check if the domain matches the domain of any of the other tabs and, if it does, we group them together if there are more than X tabs for that domain
    // auto grouping (pattern based) should take precedence over magic autogrouping
    autoGroupingMagicByDomainEnabled: false,
    autoGroupingMagicIncludeGroupedTabs: false,  // whether already grouped tabs are considered for magic auto-grouping
    autoGroupingMagicMinTabsByDomain: 3,  // minimum number of tabs with the same domain before we start auto-grouping them together (must be >= 2)

    // maps tab group names to lists of rules that define which tabs get auto-grouped into that group
    autoGroupRules: {
        'Streaming':
            [
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'youtube.com' },
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'twitch.tv' },
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'netflix.com' },
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'channel4.com' },
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'bbc.co.uk' },
            ],
        'Guild Wars 2':
            [
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'guildwars2.com' },
            ],
        'Testing':
            [
                // any URL with a GET param "test=autogroup" gets added to the "Testing" tab group
                { type: AUTO_GROUP_PATTERN_TYPE.REGEXP, pattern: '^https?://([^/]+)/[\\?&]test=autogroup', regexpCompiled: null },
            ],
        'Shopping':
            [
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'amazon.co.uk' },
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'ebay.co.uk' },
            ],
        'SHARED':
            [
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'mail.google.com' },
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'calendar.google.com' },
            ],
        'AI':
            [
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'gemini.google.com' },
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'perplexity.ai' },
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'chatgpt.com' },
            ],
        'Overwatch':
            [
                // an example of why you might want domainname pattern to match anywhere within the domain rather than just at the end
                //  - matching 'overwatch.*' would be nicer, but this is hardly a tragedy
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'overwatch.blizzard.com' },
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'overwatch.fandom.com' },
            ],
        'Health':
            [
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'nhs.uk' },
            ],
        'Employment':
            [
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'universal-credit.service.gov.uk' },
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'cv-library.co.uk' },
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'glassdoor.co.uk' },
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'charityjob.co.uk' },
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'indeed.com' },
            ],
        'Education':
            [
                //
                { type: AUTO_GROUP_PATTERN_TYPE.DOMAINNAME, pattern: 'classroom.google.com' },
                { type: AUTO_GROUP_PATTERN_TYPE.REGEXP, pattern: '^https?://([^/]+)\.google\.com/u/1', regexpCompiled: null },
                // URL path starts with "/u/1/" (shows 2nd user account in use)
            ]
    }


});