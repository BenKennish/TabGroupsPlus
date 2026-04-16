import { DEFAULT_OPTIONS, CONSOLE_PREFIX, validateOptions } from './shared.js'


// TODO: is there a better way for us to handle the HTML options and how they map to an HTML control?

document.addEventListener('DOMContentLoaded', () =>
{
    // Save options when the form is submitted
    document.getElementById('options-form').addEventListener('submit', (event) =>
    {
        // onSubmit...

        event.preventDefault()


        // TODO:
        const optionsToSave = {
            compactOnActivateUngroupedTab: document.getElementById('compactOnActivateUngroupedTab').checked,
            collapsePreviousActiveGroupOnActivateUngroupedTab: document.getElementById('collapsePreviousActiveGroupOnActivateUngroupedTab').checked,
            alignActiveTabGroup: parseInt(document.getElementById('alignActiveTabGroup').value, 10),
            moveNewTabsToGroupOfLastActiveTabInWindow: document.getElementById('moveNewTabsToGroupOfLastActiveTabInWindow').checked,
            delayCompactOnEnterContentAreaMs: parseInt(document.getElementById('delayCompactOnEnterContentAreaMs').value, 10),  // base 10
            delayCompactOnActivateUninjectedTabMs: parseInt(document.getElementById('delayCompactOnActivateUninjectedTabMs').value, 10) // base 10

            // autoGroupingEnabled
            // autoGroupingChecksExistingTabs
            // autoGroupRules
        }

        try
        {
            // will throw on error, or give console warning
            validateOptions(optionsToSave)

            chrome.storage.sync.set(optionsToSave)
                .then(() =>
                {
                    // background.js has a listener for the storage being updated so we just close the options window
                    // and let it handle it
                    window.close()

                }).catch((err) =>
                {
                    console.error(`${CONSOLE_PREFIX} Error setting options in storage:`, err)
                })
        }
        catch (err)
        {
            console.error(`${CONSOLE_PREFIX} Failed to save options as validation failed`)
        }
        // background.js has an event handler registered for chrome.storage.onChanged
        // so when we update the sync storage, this will be
    })

    // Close window when cancel button clicked
    document.getElementById('cancelBtn').addEventListener('click', (event) =>
    {
        event.preventDefault()
        window.close()
    })


    // Reset options object when reset button pressed
    document.getElementById('resetBtn').addEventListener('click', (event) =>
    {
        event.preventDefault()

        console.log(`${CONSOLE_PREFIX} Reset button clicked - resetting options to defaults...`)

        // TODO: an "are you sure?" prompt would be nice

        // TODO: nuke ALL properties, even ones we don't recognise?  maybe that's rude

        // nuke all properties in storage
        chrome.storage.sync.remove(Object.keys(DEFAULT_OPTIONS))
            .then(() =>
            {
                console.log(`${CONSOLE_PREFIX} All options removed.  Saving default options...`)

                // we could now just reload the options panel but there will be a problem if they press cancel
                // as none of the properties will be saved.  so we force a save of the default (reset) options
                // before reloading the panel

                chrome.storage.sync.set(DEFAULT_OPTIONS)
                    .then(() =>
                    {
                        console.log(`${CONSOLE_PREFIX} Default options set.  Reloading option window to show default options...`)
                        window.location.reload()  //FIXME: this is reloading the whole extension page, not just options.html?
                    })
                    .catch((error) =>
                    {
                        console.error(`${CONSOLE_PREFIX} Error setting default options:`, error)
                    })

            })
            .catch((error) =>
            {
                console.error(`${CONSOLE_PREFIX} Error resetting options:`, error)
            })
    })

    // Load saved options
    chrome.storage.sync.get(DEFAULT_OPTIONS, (options) =>
    {
        console.log(`${CONSOLE_PREFIX} Updating HTML controls to match options object...`, options)

        document.getElementById('alignActiveTabGroup').value = options.alignActiveTabGroup
        document.getElementById('compactOnActivateUngroupedTab').checked = options.compactOnActivateUngroupedTab
        document.getElementById('collapsePreviousActiveGroupOnActivateUngroupedTab').checked = options.collapsePreviousActiveGroupOnActivateUngroupedTab

        document.getElementById('moveNewTabsToGroupOfLastActiveTabInWindow').checked = options.moveNewTabsToGroupOfLastActiveTabInWindow
        document.getElementById('delayCompactOnEnterContentAreaMs').value = options.delayCompactOnEnterContentAreaMs
        document.getElementById('delayCompactOnActivateUninjectedTabMs').value = options.delayCompactOnActivateUninjectedTabMs

    })

    chrome.tabGroups.query({})
        .then((tabGroups) =>
        {
            const tabGroupTitles = tabGroups.map((group) => group.title)

            document.getElementById('addAutoGroup').addEventListener('click', (event) =>
            {
                event.preventDefault()

                let autoGroupDiv = document.createElement('div')

                autoGroupDiv.appendChild(document.createTextNode("Group: "))

                // add a drop down
                let tabGroupTitleDropdown = document.createElement('select')
                tabGroupTitleDropdown.id = 'tabGroupTitle' // FIXME: not unique
                for (const title of tabGroupTitles)
                {
                    let option = document.createElement('option')
                    option.value = title
                    option.text = title
                    tabGroupTitleDropdown.appendChild(option)
                }
                autoGroupDiv.appendChild(tabGroupTitleDropdown)

                let rulesDiv = document.createElement('div')
                rulesDiv.classList.add('autoGroupingRulesPanel')
                rulesDiv.appendChild(document.createTextNode("Rules go here"))

                // add an "add rule"
                let addRule = document.createElement('a')
                addRule.href = "#"
                addRule.append(document.createTextNode("Add Rule"))
                // TODO: add functionality
                autoGroupDiv.appendChild(addRule)

                // add a "remove group"
                let removeGroup = document.createElement('a')
                removeGroup.href = "#"
                removeGroup.append(document.createTextNode("Remove Group"))
                removeGroup.addEventListener('click', (event) =>
                {
                    event.preventDefault()
                    autoGroupDiv.remove()
                })
                autoGroupDiv.appendChild(removeGroup)

                autoGroupDiv.appendChild(rulesDiv)

                document.getElementById('autoGroupingRules').append(autoGroupDiv)
            })
        })
        .catch((err) =>
        {
            console.error(`${CONSOLE_PREFIX} Error fetching tab groups to populate drop-down`, err)
        })


})
