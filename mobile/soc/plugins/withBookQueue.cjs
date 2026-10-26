const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod } = require('expo/config-plugins');

// Expo 56's AudioPlayer already owns the foreground media session (and AVQueuePlayer).
// Add append-only book tracks to that player so native code advances while JS is asleep.
// Fail on SDK drift rather than silently shipping the old one-phrase implementation.
function patch(file, edits) {
  let source = fs.readFileSync(file, 'utf8');
  if (source.includes('// Soc book queue')) return;
  for (const [before, after] of edits) {
    if (!source.includes(before)) throw new Error(`Book queue patch no longer matches ${path.basename(file)}: ${before.slice(0, 70)}`);
    source = source.replace(before, after);
  }
  fs.writeFileSync(file, source, 'utf8');
}

module.exports = function withBookQueue(config) {
  for (const platform of ['android', 'ios']) config = withDangerousMod(config, [platform, async (mod) => {
    const root = path.dirname(require.resolve('expo-audio/package.json', { paths: [mod.modRequest.projectRoot] }));
    if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version !== '56.0.12') throw new Error('Review book queue patch before updating expo-audio');
    if (platform === 'android') {
      const base = path.join(root, 'android/src/main/java/expo/modules/audio');
      patch(path.join(base, 'AudioPlayer.kt'), [
        ['  var preservesPitch = true', `  // Soc book queue
  val bookKeys = mutableListOf<String>()
  val bookRates = mutableListOf<Float>()
  fun bookRate(rate: Float) {
    val at = ref.currentMediaItemIndex
    val factor = rate / (bookRates.getOrNull(at) ?: rate)
    for (i in bookRates.indices) bookRates[i] = (bookRates[i] * factor).coerceIn(0.1f, 2.0f)
    setPlaybackRate(rate)
  }
  override fun onMediaItemChanged(mediaItem: androidx.media3.common.MediaItem?, reason: Int) {
    bookRates.getOrNull(ref.currentMediaItemIndex)?.let { setPlaybackRate(it) }
    super.onMediaItemChanged(mediaItem, reason)
  }
  var preservesPitch = true`],
        ['      "id" to id,', '      "bookKey" to bookKeys.getOrNull(ref.currentMediaItemIndex),\n      "id" to id,'],
        ['    .setLooper(context.mainLooper)', '    .setLooper(context.mainLooper)\n    .setWakeMode(C.WAKE_MODE_LOCAL)'],
      ]);
      patch(path.join(base, 'AudioModule.kt'), [
        ['    Class(AudioPlayer::class) {', `    // Soc book queue
    Class(AudioPlayer::class) {
      Function("bookReplace") { player: AudioPlayer, source: AudioSource, key: String, rate: Float ->
        runOnMain {
          createMediaItem(source)?.let { media ->
            player.bookKeys.clear(); player.bookRates.clear()
            player.bookKeys.add(key); player.bookRates.add(rate)
            player.setMediaSource(media)
          }
        }
      }
      Function("bookAppend") { player: AudioPlayer, source: AudioSource, key: String, rate: Float ->
        runOnMain {
          createMediaItem(source)?.let { media ->
            val trim = player.ref.currentMediaItemIndex - 8
            if (trim > 0) {
              player.bookKeys.subList(0, trim).clear(); player.bookRates.subList(0, trim).clear()
              player.ref.removeMediaItems(0, trim)
            }
            player.bookKeys.add(key); player.bookRates.add(rate)
            player.ref.addMediaSource(media)
          }
        }
      }
      Function("bookRate") { player: AudioPlayer, rate: Float -> runOnMain { player.bookRate(rate) } }
`],
      ]);
    } else {
      const base = path.join(root, 'ios');
      patch(path.join(base, 'AudioPlayer.swift'), [
        ['  var shouldCorrectPitch = true', `  // Soc book queue
  private var bookEntries: [ObjectIdentifier: (key: String, rate: Float)] = [:]
  private var lastBookKey = ""
  var bookKey: String {
    guard let item = ref.currentItem else { return lastBookKey }
    return bookEntries[ObjectIdentifier(item)]?.key ?? ""
  }
  func bookReplace(source: AudioSource, key: String, rate: Float) {
    bookEntries.removeAll(); lastBookKey = key
    replaceCurrentSource(source: source)
    if let item = ref.currentItem { bookEntries[ObjectIdentifier(item)] = (key, rate) }
  }
  func bookAppend(source: AudioSource, key: String, rate: Float) {
    guard let queue = ref as? AVQueuePlayer,
      let item = AudioUtils.createAVPlayerItem(from: source), queue.canInsert(item, after: nil) else { return }
    item.audioTimePitchAlgorithm = pitchCorrectionQuality
    bookEntries[ObjectIdentifier(item)] = (key, rate)
    queue.insert(item, after: nil)
    ref.actionAtItemEnd = .advance
  }
  func bookRate(_ rate: Float) {
    let old = ref.currentItem.flatMap { bookEntries[ObjectIdentifier($0)]?.rate } ?? rate
    let factor = old > 0 ? rate / old : 1
    for id in Array(bookEntries.keys) {
      if let entry = bookEntries[id] { bookEntries[id] = (entry.key, max(0.1, min(2, entry.rate * factor))) }
    }
    currentRate = rate
    if isPlaying { ref.rate = rate }
  }
  var shouldCorrectPitch = true`],
        ['    ref.actionAtItemEnd = isLooping ? .advance : .pause', '    ref.actionAtItemEnd = isLooping || !bookEntries.isEmpty ? .advance : .pause'],
        ['      "id": id,', '      "bookKey": bookKey,\n      "id": id,'],
        ['        if self.isLooping {\n          self.enqueueNextLoopItem()\n          self.addPlaybackEndNotification()', `        if let item = self.ref.currentItem, let entry = self.bookEntries[ObjectIdentifier(item)] {
          self.lastBookKey = entry.key
          self.currentRate = entry.rate
          if self.ref.rate > 0 { self.ref.rate = entry.rate }
          self.updateStatus(with: [:])
        }
        if self.isLooping {
          self.enqueueNextLoopItem()
          self.addPlaybackEndNotification()`],
        ['      guard let queuePlayer = self.ref as? AVQueuePlayer,', `      if let entry = self.bookEntries[ObjectIdentifier(finishedItem)] {
        self.bookEntries.removeValue(forKey: ObjectIdentifier(finishedItem))
        // A queued successor advances in AVFoundation, without waiting for JS or deactivating the session.
        if self.ref.currentItem != nil && self.ref.currentItem !== finishedItem { return }
        if let queue = self.ref as? AVQueuePlayer, queue.items().contains(where: { $0 !== finishedItem }) { return }
        let seconds = finishedItem.duration.seconds
        self.lastBookKey = entry.key
        self.updateStatus(with: ["bookKey": entry.key, "playing": false, "currentTime": seconds.isFinite ? seconds : 0, "didJustFinish": true])
        return
      }
      guard let queuePlayer = self.ref as? AVQueuePlayer,`],
      ]);
      patch(path.join(base, 'AudioModule.swift'), [
        ['    Class(AudioPlayer.self) {', `    // Soc book queue
    Class(AudioPlayer.self) {
      Function("bookReplace") { (player: AudioPlayer, source: AudioSource, key: String, rate: Float) in
        player.bookReplace(source: source, key: key, rate: rate)
      }
      Function("bookAppend") { (player: AudioPlayer, source: AudioSource, key: String, rate: Float) in
        player.bookAppend(source: source, key: key, rate: rate)
      }
      Function("bookRate") { (player: AudioPlayer, rate: Float) in player.bookRate(rate) }
`],
      ]);
    }
    return mod;
  }]);
  return config;
};
