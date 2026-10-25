const { withBaseMod } = require('expo/config-plugins');

// Only local reminders are used. Expo Notifications otherwise adds APNs,
// which a free Personal Team cannot provision.
module.exports = function withPersonalIOS(config) {
  return withBaseMod(config, {
    platform: 'ios',
    mod: 'entitlements',
    async action({ modRequest, ...rest }) {
      // Run the earlier notification mod first, then remove its entitlement.
      const result = await modRequest.nextMod({ ...rest, modRequest });
      delete result.modResults['aps-environment'];
      return result;
    },
  });
};
