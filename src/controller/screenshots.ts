import { PNG } from "pngjs";
import type { LogicInspector } from "../mcp/inspector";
/** Capture a scroll container by moving its real scroll position; always restore it and release the remote reference. */
export async function captureContainer(
  client: LogicInspector,
  selector: string,
) {
  const expression = `(()=>{const found=[];function scan(root){for(const e of root.querySelectorAll('*')){if(e.matches(${JSON.stringify(selector)}))found.push(e);if(e.shadowRoot)scan(e.shadowRoot)}}scan(document);if(found.length!==1)throw Error('Container selector must match exactly one element');return found[0]})()`;
  const selected = await client.command("evaluate", {
    expression,
    viewTarget: true,
    returnByValue: false,
  });
  if (selected.exceptionDetails || !selected.result?.objectId)
    throw Error(
      selected.exceptionDetails?.text || "Scroll container not found",
    );
  const objectId = selected.result.objectId;
  const run = async (fn: string, args: any[] = []) => {
    const result = await client.raw("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: fn,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text,
      );
    return result.result.value;
  };
  let original: any;
  try {
    original = await run(
      `function(){if(!this.isConnected)throw Error('Container is stale');const r=this.getBoundingClientRect();return {left:this.scrollLeft,top:this.scrollTop,width:this.scrollWidth,height:this.scrollHeight,clientWidth:this.clientWidth,clientHeight:this.clientHeight,x:r.x+this.clientLeft,y:r.y+this.clientTop,viewportWidth:innerWidth,viewportHeight:innerHeight}}`,
    );
    if (
      !original.clientWidth ||
      !original.clientHeight ||
      original.x < 0 ||
      original.y < 0 ||
      original.x + original.clientWidth > original.viewportWidth ||
      original.y + original.clientHeight > original.viewportHeight
    )
      throw Error("Scroll container must be fully visible in the viewport");
    if (original.width * original.height > 64000000)
      throw Error("Scroll container exceeds 64 million pixels");
    const output = new PNG({ width: original.width, height: original.height });
    let tiles = 0;
    let colorChunks: Buffer[] = [];
    for (let y = 0; y < original.height; y += original.clientHeight)
      for (let x = 0; x < original.width; x += original.clientWidth) {
        if (++tiles > 256)
          throw Error("Scroll container exceeds 256 screenshot tiles");
        const position = await run(
          `async function(x,y){if(!this.isConnected)throw Error('Container became stale');this.scrollTo({left:x,top:y,behavior:'instant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const r=this.getBoundingClientRect();return {left:this.scrollLeft,top:this.scrollTop,width:this.scrollWidth,height:this.scrollHeight,x:r.x+this.clientLeft+scrollX,y:r.y+this.clientTop+scrollY}}`,
          [x, y],
        );
        if (
          position.width !== original.width ||
          position.height !== original.height
        )
          throw Error(
            "Container content changed while capturing; screenshot is incomplete",
          );
        const width = Math.min(original.clientWidth, original.width - x),
          height = Math.min(original.clientHeight, original.height - y);
        const shot = await client.raw("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          clip: {
            x: position.x + x - position.left,
            y: position.y + y - position.top,
            width,
            height,
            scale: 1,
          },
        });
        const png = Buffer.from(shot.data, "base64");
        if (tiles === 1) {
          for (let pos = 8; pos + 12 <= png.length;) {
            const length = png.readUInt32BE(pos),
              type = png.toString("ascii", pos + 4, pos + 8);
            if (
              ["iCCP", "cICP", "gAMA", "cHRM", "sRGB", "mDCV", "cLLI"].includes(
                type,
              )
            )
              colorChunks.push(png.subarray(pos, pos + length + 12));
            pos += length + 12;
          }
        }
        const tile = PNG.sync.read(png);
        // Capture clips are CSS pixels; downsample physical device pixels if Chromium returns a scaled image.
        for (let row = 0; row < height; row++)
          for (let col = 0; col < width; col++) {
            const src =
              (Math.floor((row * tile.height) / height) * tile.width +
                Math.floor((col * tile.width) / width)) *
              4;
            tile.data.copy(
              output.data,
              ((y + row) * original.width + x + col) * 4,
              src,
              src + 4,
            );
          }
      }
    const encoded = PNG.sync.write(output);
    const image = Buffer.concat([
      encoded.subarray(0, 33),
      ...colorChunks,
      encoded.subarray(33),
    ]);
    return {
      image: image.toString("base64"),
      mimeType: "image/png",
      width: original.width,
      height: original.height,
      tiles,
      method: "scroll-and-stitch",
      contentMayReactToScroll: true,
    };
  } finally {
    try {
      if (original)
        await run(
          `async function(x,y){if(!this.isConnected)throw Error("Container closed before scroll restoration");this.scrollTo({left:x,top:y,behavior:'instant'});await new Promise(r=>requestAnimationFrame(r));if(this.scrollLeft!==x||this.scrollTop!==y)throw Error("Container scroll could not be restored")}`,
          [original.left, original.top],
        );
    } finally {
      await client.raw("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }
}
