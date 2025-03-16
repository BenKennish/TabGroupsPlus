import { DEFAULT_OPTIONS } from './shared.js';

document.addEventListener('DOMContentLoaded', function ()
{
    // Load saved options
    chrome.storage.sync.get(DEFAULT_OPTIONS, function (options)
    {
        console.log("Updating HTML to match options...", options);

        // update the HTML to match the options
        document.getElementById('collapseOthersWithGrouplessTab').checked = options.collapseOthersWithGrouplessTab;
        document.getElementById('alignTabGroupsAfterCollapsing').value = options.alignTabGroupsAfterCollapsing;
        document.getElementById('collapseDelayOnEnterContentAreaMs').value = options.collapseDelayOnEnterContentAreaMs;
        document.getElementById('collapseDelayOnActivateUninjectedTabMs').value = options.collapseDelayOnActivateUninjectedTabMs;
        document.getElementById('autoGroupNewTabs').checked = options.autoGroupNewTabs;
    });

    // Save options when the form is submitted
    document.getElementById('options-form').addEventListener('submit', function (e)
    {
        e.preventDefault();


        let optionsToSave = {
            collapseOthersWithGrouplessTab: document.getElementById('collapseOthersWithGrouplessTab').checked,

            alignTabGroupsAfterCollapsing: parseInt(document.getElementById('alignTabGroupsAfterCollapsing').value, 10),
            collapseDelayOnEnterContentAreaMs: parseInt(document.getElementById('collapseDelayOnEnterContentAreaMs').value, 10),
            collapseDelayOnActivateUninjectedTabMs: parseInt(document.getElementById('collapseDelayOnActivateUninjectedTabMs').value, 10),

            autoGroupNewTabs: document.getElementById('autoGroupNewTabs').checked
        }

        chrome.storage.sync.set(optionsToSave, function ()
        {
            // background.js has a listener for the storage being updated so we don't need to do anything here
        });
    });
});
