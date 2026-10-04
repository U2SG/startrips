/**
 * #393 3D Journey Book: the order in which one page's pictures are decoded.
 *
 * A face paints its sources best last (a photo's preview, then its original).
 * Every await may outlive the page being wanted, so nothing is reported once
 * `isLive` turns false.
 */
export type PictureChainSteps<T> = {
  load: (url: string) => Promise<T>;
  /** After a CORS-mode failure: does the same URL load as a plain image? */
  loadsWithoutCors: (url: string) => Promise<boolean>;
  /** The page still wants exactly these sources. */
  isLive: () => boolean;
  present: (picture: T) => void;
  /** The best source decoded. */
  onComplete: () => void;
  /** Nothing decoded and the storage refuses cross-origin reads. */
  onCorsRefused: () => void;
  /** Nothing decoded: the read should be renewed (an expired signed URL). */
  onExpire: () => void;
};

export async function loadPictureChain<T>(urls: readonly string[], steps: PictureChainSteps<T>): Promise<void> {
  let decoded = false;
  for (const [index, url] of urls.entries()) {
    const last = index === urls.length - 1;
    let picture: T;
    try {
      picture = await steps.load(url);
    } catch {
      if (!steps.isLive()) return;
      // A failed preview still leaves the original to try.
      if (!last) continue;
      // A failed original keeps the preview that already decoded.
      if (decoded) return;
      const refused = await steps.loadsWithoutCors(url);
      if (!steps.isLive()) return;
      if (refused) steps.onCorsRefused();
      else steps.onExpire();
      return;
    }
    if (!steps.isLive()) return;
    steps.present(picture);
    decoded = true;
    if (last) steps.onComplete();
  }
}
