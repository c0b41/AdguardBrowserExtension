/**
 * This file is part of Adguard Browser Extension (https://github.com/AdguardTeam/AdguardBrowserExtension).
 *
 * Adguard Browser Extension is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Adguard Browser Extension is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Adguard Browser Extension.  If not, see <http://www.gnu.org/licenses/>.
 */

/* global Promise, Log */

/**
 * Sync settings service
 *
 * @type {{syncSettings, setSyncProvider}}
 */
var SyncService = (function () { // jshint ignore:line
    var MANIFEST_PATH = "manifest.json";

    var syncProvider = null;

    /**
     * Constructs the special object containing information about manifests protocols compatibility and then sorts data sections
     * into arrays by directions we should sync the data.
     *
     * @param remoteManifest
     * @param localManifest
     * @returns {{canRead: boolean, canWrite: boolean, sectionsRemoteToLocal: Array, sectionsLocalToRemote: Array}}
     */
    var findCompatibility = function (remoteManifest, localManifest) {
        var canRead = remoteManifest["min-compatible-version"] <= localManifest["min-compatible-version"];
        var canWrite = remoteManifest["protocol-version"] <= localManifest["protocol-version"];

        var sectionsRemoteToLocal = [];
        var sectionsLocalToRemote = [];

        if (canRead) {
            for (var i = 0; i < remoteManifest.sections.length; i++) {
                var remoteSection = remoteManifest.sections[i];
                for (var j = 0; j < localManifest.sections.length; j++) {
                    var localSection = localManifest.sections[j];
                    if (localSection.name === remoteSection.name) {
                        var sectionName = localSection.name;
                        if (localSection.timestamp === remoteSection.timestamp) {
                            //Do nothing it's synced
                        } else if (localSection.timestamp < remoteSection.timestamp) {
                            sectionsRemoteToLocal.push({
                                name: sectionName,
                                timestamp: remoteSection.timestamp
                            });
                        } else {
                            if (canWrite) {
                                sectionsLocalToRemote.push({
                                    name: sectionName,
                                    timestamp: localSection.timestamp
                                });
                            }
                        }
                    }
                }
            }
        }

        return {
            canRead: canRead,
            canWrite: canWrite,
            sectionsRemoteToLocal: sectionsRemoteToLocal,
            sectionsLocalToRemote: sectionsLocalToRemote
        }
    };

    var validateManifest = function (manifest) {
        return manifest["min-compatible-version"]
            && manifest["protocol-version"]
            && manifest["timestamp"];
    };

    /**
     * So how does it work:
     * At first we load manifests for remote and local and then are trying to find can we merge the datasets comparing
     * protocol versions. Then comparing the timestamps for sections we find the newer data and pick it in some collections
     * corresponding to the direction: remote-to-local or local-to-remote.
     *
     * After that we load selected data sections and process the compatibility result by processSections method,
     * simply saving the newer sections to remote or local storage.
     *
     * As the end we updated manifests with processSections result, setting up the sections timestamps.
     *
     * @param callback
     */
    var processManifest = function (callback) {
        var onManifestLoaded = function (remoteManifest) {
            Log.info('Processing remote manifest..');

            if (!remoteManifest) {
                Log.warn('Error loading remote manifest');
                callback(false);
                return;
            }

            if (!validateManifest(remoteManifest)) {
                Log.warn('Remote manifest not valid');
                callback(false);
                return;
            }

            var localManifest = SettingsProvider.loadSettingsManifest();

            var compatibility = findCompatibility(remoteManifest, localManifest);
            //console.log(compatibility);
            if (!compatibility.canRead) {
                Log.warn('Protocol versions are not compatible');
                callback(false);
                return;
            }

            processSections(localManifest, remoteManifest, compatibility, function (success, updatedSections) {
                if (!success) {
                    callback(false);
                    return;
                }

                Log.info('Sections updated local-to-remote: {0}, remote-to-local: {1}', updatedSections.localToRemote.length, updatedSections.remoteToLocal.length);

                var updatedDate = new Date().getTime();
                if (updatedSections.remoteToLocal.length > 0) {
                    Log.debug('Saving local manifest..');

                    updateManifestSections(localManifest.sections, updatedSections.remoteToLocal);

                    localManifest.timestamp = updatedDate;
                    SettingsProvider.saveSettingsManifest(localManifest);
                }

                if (compatibility.canWrite) {
                    Log.debug('Saving remote manifest..');

                    updateManifestSections(remoteManifest.sections, updatedSections.localToRemote);

                    remoteManifest.timestamp = updatedDate;
                    remoteManifest["app-id"] = localManifest["app-id"];

                    SyncProvider.save(MANIFEST_PATH, remoteManifest, callback);
                } else {
                    callback(true);
                }
            });
        };

        Log.debug('Loading remote manifest..');
        SyncProvider.load(MANIFEST_PATH, onManifestLoaded);
    };

    /**
     * Processes sections synchronization.
     * Return object with updates sections info.
     *
     * @param localManifest
     * @param remoteManifest
     * @param compatibility
     * @param callback
     */
    var processSections = function (localManifest, remoteManifest, compatibility, callback) {
        var updatedSections = {
            localToRemote: [],
            remoteToLocal: []
        };

        var dfds = [];
        var dfd;

        for (var i = 0; i < compatibility.sectionsLocalToRemote.length; i++) {
            dfd = updateLocalToRemoteSection(compatibility.sectionsLocalToRemote[i], function (section) {
                updatedSections.localToRemote.push(section);
            });

            dfds.push(dfd);
        }

        for (var j = 0; j < compatibility.sectionsRemoteToLocal.length; j++) {
            dfd = updateRemoteToLocalSection(compatibility.sectionsRemoteToLocal[j], function (section) {
                updatedSections.remoteToLocal.push(section);
            });

            dfds.push(dfd);
        }

        Promise.all(dfds).then(function () {
            Log.info('Sections updated successfully');

            callback(true, updatedSections);
        }, function () {
            Log.error('Sections update failed');

            callback(false, updatedSections);
        });
    };

    /**
     * Updates sections timestamps
     *
     * @param manifestSections
     * @param updatedSections
     */
    var updateManifestSections = function (manifestSections, updatedSections) {
        for (var i = 0; i < manifestSections.length; i++) {
            var section = manifestSections[i];
            for (var j = 0; j < updatedSections.length; j++) {
                if (section.name === updatedSections[j].name) {
                    section.timestamp = updatedSections[j].timestamp;
                }
            }
        }
    };

    var updateLocalToRemoteSection = function (section, callback) {
        var sectionName = section.name;
        Log.info('Updating local to remote: ' + section.name);

        var dfd = new Promise();

        SettingsProvider.loadSettingsSection(sectionName, function (localFiltersSection) {
            Log.debug('Local {0} section loaded', sectionName);

            SyncProvider.save(sectionName, localFiltersSection, function (success) {
                if (success) {
                    Log.info('Remote {0} section updated', sectionName);

                    callback(section);

                    dfd.resolve();
                } else {
                    Log.error('Remote {0} section update failed', sectionName);

                    dfd.reject();
                }
            });
        });

        return dfd;
    };

    var updateRemoteToLocalSection = function (section, callback) {
        var sectionName = section.name;
        Log.info('Updating remote to local: ' + sectionName);

        var dfd = new Promise();

        SyncProvider.load(sectionName, function (remoteFiltersSection) {
            Log.debug('Remote {0} section loaded', sectionName);

            SettingsProvider.saveSettingsSection(sectionName, remoteFiltersSection, function (success) {
                if (success) {
                    Log.info('Local {0} section updated', sectionName);

                    callback(section);

                    dfd.resolve();
                } else {
                    Log.error('Local {0} section update failed', sectionName);

                    dfd.reject();
                }
            });
        });

        return dfd;
    };


    // API
    var syncSettings = function (callback) {
        Log.info('Synchronizing settings..');

        if (syncProvider == null) {
            Log.error('Sync provider should be set first');

            callback(false);
            return;
        }

        processManifest(function (success) {
            if (success) {
                Log.info('Synchronizing settings finished');
            } else {
                Log.warn('Error synchronizing settings');
            }

            callback(success);
        });
    };

    var setSyncProvider = function (provider) {
        syncProvider = provider;

        Log.debug('Sync provider has been set');
    };

    // EXPOSE
    return {
        /**
         * Synchronizes settings between current application and sync provider
         */
        syncSettings: syncSettings,
        /**
         * Sets sync provider to current service
         */
        setSyncProvider: setSyncProvider
    };
})();