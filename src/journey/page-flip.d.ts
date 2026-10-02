// The subset of St.PageFlip 2.0.7 (MIT, https://github.com/Nodlik/StPageFlip)
// the Journey Book uses. The package ships no type declarations.
declare module "page-flip" {
  export type FlippingState = "user_fold" | "fold_corner" | "flipping" | "read";
  export type Orientation = "portrait" | "landscape";

  export type FlipSetting = {
    startPage: number;
    size: "fixed" | "stretch";
    width: number;
    height: number;
    minWidth: number;
    maxWidth: number;
    minHeight: number;
    maxHeight: number;
    drawShadow: boolean;
    flippingTime: number;
    usePortrait: boolean;
    startZIndex: number;
    autoSize: boolean;
    maxShadowOpacity: number;
    showCover: boolean;
    mobileScrollSupport: boolean;
    clickEventForward: boolean;
    useMouseEvents: boolean;
    swipeDistance: number;
    showPageCorners: boolean;
    disableFlipByClick: boolean;
  };

  export type PageFlipEvent<T> = { data: T; object: PageFlip };

  export class PageFlip {
    constructor(block: HTMLElement, setting: Partial<FlipSetting>);
    loadFromHTML(items: HTMLElement[]): void;
    destroy(): void;
    update(): void;
    turnToPage(page: number): void;
    flipNext(corner?: "top" | "bottom"): void;
    flipPrev(corner?: "top" | "bottom"): void;
    getCurrentPageIndex(): number;
    getPageCount(): number;
    getOrientation(): Orientation;
    getState(): FlippingState;
    /** Pointer input, in coordinates relative to the `.stf__block` element. */
    startUserTouch(point: { x: number; y: number }): void;
    userMove(point: { x: number; y: number }, isTouch: boolean): void;
    userStop(point: { x: number; y: number }, isSwipe?: boolean): void;
    on(event: "flip", callback: (event: PageFlipEvent<number>) => void): PageFlip;
    on(event: "changeState", callback: (event: PageFlipEvent<FlippingState>) => void): PageFlip;
    on(event: "changeOrientation", callback: (event: PageFlipEvent<Orientation>) => void): PageFlip;
    on(event: "init" | "update", callback: (event: PageFlipEvent<{ page: number; mode: Orientation }>) => void): PageFlip;
  }
}
