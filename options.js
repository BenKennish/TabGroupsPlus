import { DEFAULT_OPTIONS, CONSOLE_PREFIX } from './shared.js';

document.addEventListener('DOMContentLoaded', function ()
{
    // Load saved options
    chrome.storage.sync.get(DEFAULT_OPTIONS, (options) =>
    {
        console.log(`${CONSOLE_PREFIX} Updating HTML controls to match options object...`, options);

        document.getElementById('compactOnActivateUngroupedTab').checked = options.compactOnActivateUngroupedTab;
        document.getElementById('collapsePreviousActiveGroupOnActivateUngroupedTab').checked = options.collapsePreviousActiveGroupOnActivateUngroupedTab;
        document.getElementById('alignActiveTabGroup').value = options.alignActiveTabGroup;
        document.getElementById('delayCompactOnEnterContentAreaMs').value = options.delayCompactOnEnterContentAreaMs;
        document.getElementById('delayCompactOnActivateUninjectedTabMs').value = options.delayCompactOnActivateUninjectedTabMs;
        document.getElementById('autoGroupNewTabs').checked = options.autoGroupNewTabs;
    });

    // Save options when the form is submitted
    document.getElementById('options-form').addEventListener('submit', (event) =>
    {
        // onSubmit...

        event.preventDefault();

        const optionsToSave = {
            compactOnActivateUngroupedTab: document.getElementById('compactOnActivateUngroupedTab').checked,
            collapsePreviousActiveGroupOnActivateUngroupedTab: document.getElementById('collapsePreviousActiveGroupOnActivateUngroupedTab').checked,
            alignActiveTabGroup: parseInt(document.getElementById('alignActiveTabGroup').value, 10),
            delayCompactOnEnterContentAreaMs: parseInt(document.getElementById('delayCompactOnEnterContentAreaMs').value, 10),  // base 10
            delayCompactOnActivateUninjectedTabMs: parseInt(document.getElementById('delayCompactOnActivateUninjectedTabMs').value, 10), // base 10
            autoGroupNewTabs: document.getElementById('autoGroupNewTabs').checked
        }

        chrome.storage.sync.set(optionsToSave, () =>
        {
            if (chrome.runtime.lastError)
            {
                console.error(`${CONSOLE_PREFIX} Error setting options in storage:`, chrome.runtime.lastError.message);
            }

            // background.js has a listener for the storage being updated so we just close the options window
            // and let it handle it
            window.close();
        });
    });

    // Close window when cancel button clicked
    document.getElementById('cancel').addEventListener('click', (event) =>
    {
        event.preventDefault();
        window.close();
    });


    // Reset options object when reset button pressed
    document.getElementById('resetBtn').addEventListener('click', (event) =>
    {
        event.preventDefault();

        console.log(`${CONSOLE_PREFIX} Reset button clicked - resetting options to defaults...`);

        // TODO: an "are you sure?" prompt would be nice

        // TODO: nuke ALL properties, even ones we don't recognise?  maybe that's rude

        // nuke all properties in storage
        chrome.storage.sync.remove(Object.keys(DEFAULT_OPTIONS))
            .then(() =>
            {
                console.log(`${CONSOLE_PREFIX} All options removed.  Saving default options...`);

                // we could now just reload the options panel but there will be a problem if they press cancel
                // as none of the properties will be saved.  so we force a save of the default (reset) options
                // before reloading the panel

                chrome.storage.sync.set(DEFAULT_OPTIONS)
                    .then(() =>
                    {
                        console.log(`${CONSOLE_PREFIX} Default options set.  Reloading option window to show default options...`);
                        window.location.reload();  //FIXME: this is reloading the whole extension page, not just options.html?
                    })
                    .catch((error) =>
                    {
                        console.error(`${CONSOLE_PREFIX} Error setting default options:`, error);
                    });

            })
            .catch((error) =>
            {
                console.error(`${CONSOLE_PREFIX} Error resetting options:`, error);
            });
    });
});
