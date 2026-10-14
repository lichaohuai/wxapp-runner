import type { WebContents } from "electron";
import { setTimeout as delay } from "node:timers/promises";
export function keyChord(keys: string[]) {
  const aliases: Record<string, string> = {
    ctrl: "control",
    control: "control",
    cmd: "meta",
    command: "meta",
    meta: "meta",
    alt: "alt",
    option: "alt",
    shift: "shift",
  };
  const modifiers: string[] = [];
  let keyCode = "";
  for (const key of keys) {
    const modifier = aliases[key.toLowerCase()];
    if (modifier) {
      if (modifiers.includes(modifier)) throw Error("Duplicate modifier");
      modifiers.push(modifier);
    } else {
      if (keyCode) throw Error("Provide modifiers and exactly one key");
      keyCode = key;
    }
  }
  const names: Record<string, string> = {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Escape: "Escape",
    Enter: "Return",
    Space: "Space",
  };
  keyCode = names[keyCode] || keyCode;
  if (
    !/^([A-Za-z0-9]|F([1-9]|1[0-2])|Up|Down|Left|Right|Return|Tab|Space|Escape|Backspace|Delete|Home|End|PageUp|PageDown)$/.test(
      keyCode,
    )
  )
    throw Error(
      "Unsupported key; use one letter, digit, navigation key or F1–F12 plus modifiers",
    );
  return { keyCode, modifiers };
}
/** Native input events, also used by manual mouse/touch emulation in the WeChat view. */
export async function gesture(
  wc: WebContents,
  args: any,
  point: { x: number; y: number },
) {
  const send = (event: any) => {
    if (wc.isDestroyed())
      throw Error(
        "Page closed during gesture; input may already have been sent",
      );
    wc.sendInputEvent(event);
  };
  if (args.action === "keys") {
    const chord = keyChord(args.keys);
    send({ type: "keyDown", ...chord });
    send({ type: "keyUp", ...chord });
  } else if (args.action === "scroll") {
    send({ type: "mouseMove", ...point });
    send({
      type: "mouseWheel",
      ...point,
      deltaX: -(args.deltaX || 0),
      deltaY: -(args.deltaY || 0),
      canScroll: true,
    });
  } else {
    let down = false,
      last = point;
    try {
      send({ type: "mouseMove", ...point });
      send({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
      down = true;
      if (args.action === "longpress") await delay(args.durationMs ?? 650);
      else if (args.action === "drag" || args.action === "swipe") {
        const steps = Math.max(2, Math.ceil((args.durationMs ?? 400) / 25));
        for (let i = 1; i <= steps; i++) {
          await delay((args.durationMs ?? 400) / steps);
          last = {
            x: Math.round(point.x + ((args.endX - point.x) * i) / steps),
            y: Math.round(point.y + ((args.endY - point.y) * i) / steps),
          };
          send({
            type: "mouseMove",
            ...last,
            button: "left",
            modifiers: ["leftButtonDown"],
          });
        }
      }
      send({ type: "mouseUp", ...last, button: "left", clickCount: 1 });
      down = false;
      if (args.action === "doubleclick") {
        send({ type: "mouseDown", ...point, button: "left", clickCount: 2 });
        down = true;
        send({ type: "mouseUp", ...point, button: "left", clickCount: 2 });
        down = false;
      }
    } finally {
      if (down && !wc.isDestroyed())
        wc.sendInputEvent({
          type: "mouseUp",
          ...last,
          button: "left",
          clickCount: 1,
        });
    }
  }
  return {
    status: "input-sent",
    businessCompleted: false,
    action: args.action,
  };
}
