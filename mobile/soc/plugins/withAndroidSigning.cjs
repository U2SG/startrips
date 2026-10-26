const { withAppBuildGradle } = require('expo/config-plugins');

module.exports = function withAndroidSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    const marker = '// Soc compatible APK signing';
    if (!mod.modResults.contents.includes(marker)) mod.modResults.contents += `
${marker}
android.signingConfigs.all {
    enableV1Signing = true
    enableV2Signing = true
    enableV3Signing = true
}
`;
    return mod;
  });
};
