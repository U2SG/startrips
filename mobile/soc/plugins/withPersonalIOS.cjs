const { withEntitlementsPlist } = require('expo/config-plugins');

// Only local reminders are used. Expo Notifications otherwise adds APNs,
// which a free Personal Team cannot provision.
module.exports = function withPersonalIOS(config) {
  return withEntitlementsPlist(config, (result) => {
    delete result.modResults['aps-environment'];
    return result;
  });
};
