import { registerRootComponent } from 'expo';

import App from './App';
import AudioQueueQA from './src/books/AudioQueueQA';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(process.env.EXPO_PUBLIC_SOC_AUDIO_QA === '1' ? AudioQueueQA : App);
