/** Normal WAWebview video bridge. Events follow WAWebview 3.17.3's wx.on adapters. */
export function createVideoBackend(
  w: any,
  emit: (name: string, data: any) => void,
) {
  type Player = {
    host: HTMLElement;
    video: HTMLVideoElement;
    layer: HTMLElement;
    options: any;
    cleanup: () => void;
  };
  const players = new Map<number, Player>();
  const supported = /^(insert|update|remove|operate)VideoPlayer$/;
  const finite = (value: number) => (Number.isFinite(value) ? value : 0);
  function create(id: number, options: any): Player {
    const host = [...document.querySelectorAll<HTMLElement>("wx-video")].find(
      (el: any) =>
        el.__wxElement?.getContextId?.() === id ||
        el.__wxElement?.viewId === id,
    );
    if (!host) throw Error("Video component identity is unavailable");
    const layer = document.createElement("div");
    layer.dataset.runnerVideo = String(id);
    Object.assign(layer.style, {
      position: "absolute",
      inset: "0",
      overflow: "hidden",
      background: "#000",
    });
    const video = document.createElement("video");
    video.playsInline = true;
    video.preload = "metadata";
    Object.assign(video.style, {
      width: "100%",
      height: "100%",
      display: "block",
    });
    layer.append(video);
    // This container is owned by the real component; DOM geometry follows its layout.
    const container =
      host.querySelector<HTMLElement>(".wx-video-container") || host;
    if (getComputedStyle(container).position === "static")
      container.style.position = "relative";
    container.append(layer);
    const listeners: Array<() => void> = [];
    const send = (name: string, extra: any = {}) => {
      if (players.has(id))
        emit(name, { videoPlayerId: id, timeStamp: Date.now(), ...extra });
    };
    const listen = (target: EventTarget, name: string, fn: EventListener) => {
      target.addEventListener(name, fn);
      listeners.push(() => target.removeEventListener(name, fn));
    };
    for (const [dom, native] of Object.entries({
      play: "onVideoPlay",
      pause: "onVideoPause",
      waiting: "onVideoWaiting",
    }))
      listen(video, dom, () => send(native));
    listen(video, "loadedmetadata", () => {
      if (options.initialTime > 0) video.currentTime = options.initialTime;
      send("onVideoLoadedMetaData", {
        duration: finite(video.duration),
        width: video.videoWidth,
        height: video.videoHeight,
      });
    });
    let lastTime = 0;
    const danmu = new Set<number>();
    listen(video, "timeupdate", () => {
      send("onVideoTimeUpdate", {
        position: video.currentTime,
        duration: finite(video.duration),
      });
      if (video.currentTime < lastTime) danmu.clear();
      if (options.enableDanmu)
        (options.danmuList || []).forEach((item: any, index: number) => {
          if (!danmu.has(index) && item.time <= video.currentTime) {
            danmu.add(index);
            if (item.time >= lastTime) showDanmu(player, item.text, item.color);
          }
        });
      lastTime = video.currentTime;
    });
    listen(video, "progress", () =>
      send("onVideoProgress", {
        buffered:
          video.buffered.length && video.duration > 0
            ? (100 * video.buffered.end(video.buffered.length - 1)) /
              video.duration
            : 0,
      }),
    );
    // The baselib's ended adapter consumes JSON data.viewId, unlike other events.
    listen(video, "ended", () =>
      send("onVideoEnded", { data: JSON.stringify({ viewId: id }) }),
    );
    listen(video, "seeked", () =>
      send("onVideoSeekCompelete", { position: video.currentTime }),
    );
    listen(video, "error", () =>
      send("onVideoError", {
        errMsg: video.error?.message || "video media error",
        mediaErrorCode: video.error?.code,
      }),
    );
    let wasFullscreen = false;
    listen(document, "fullscreenchange", () => {
      const fullScreen =
        document.fullscreenElement === layer ||
        document.fullscreenElement === video;
      if (fullScreen !== wasFullscreen)
        send("onVideoFullScreenChange", {
          fullScreen,
          direction: "horizontal",
        });
      wasFullscreen = fullScreen;
    });
    const player = {
      host,
      video,
      layer,
      options,
      cleanup: () => {
        players.delete(id);
        listeners.forEach((fn) => fn());
        video.pause();
        video.removeAttribute("src");
        video.load();
        layer.remove();
      },
    };
    players.set(id, player);
    return player;
  }
  function showDanmu(player: Player, text: string, color = "#fff") {
    if (!text) return;
    const el = document.createElement("span");
    el.textContent = String(text);
    el.dataset.runnerDanmu = "true";
    Object.assign(el.style, {
      position: "absolute",
      left: "100%",
      top: `${10 + (player.layer.querySelectorAll("[data-runner-danmu]").length % 5) * 25}px`,
      color,
      whiteSpace: "nowrap",
      pointerEvents: "none",
      textShadow: "0 1px 2px #000",
    });
    player.layer.append(el);
    const animation = el.animate(
      [
        { transform: "translateX(0)" },
        {
          transform: `translateX(-${player.layer.clientWidth + el.offsetWidth}px)`,
        },
      ],
      { duration: 5000 },
    );
    animation.onfinish = () => el.remove();
  }
  function update(player: Player, args: any) {
    const { video, layer, options } = player;
    Object.assign(options, args);
    if (args.hide !== undefined) layer.hidden = !!args.hide;
    if (args.objectFit !== undefined) video.style.objectFit = args.objectFit;
    if (args.showBasicControls !== undefined)
      video.controls = !!args.showBasicControls;
    if (args.muted !== undefined) video.muted = !!args.muted;
    if (args.loop !== undefined) video.loop = !!args.loop;
    if (args.autoplay !== undefined) video.autoplay = !!args.autoplay;
    if (args.poster !== undefined) video.poster = args.poster;
    if (args.title !== undefined) video.title = args.title;
    if (
      args.filePath !== undefined &&
      video.getAttribute("src") !== args.filePath
    )
      video.src = args.filePath;
  }
  async function invoke(name: string, args: any) {
    const id = args.videoPlayerId;
    if (!Number.isFinite(id)) throw Error("videoPlayerId is required");
    let player = players.get(id);
    if (name === "removeVideoPlayer") {
      player?.cleanup();
      return { videoPlayerId: id };
    }
    if (name === "insertVideoPlayer" && !player) player = create(id, {});
    if (!player || !player.host.isConnected)
      throw Error("Video component is stale");
    if (name !== "operateVideoPlayer") update(player, args);
    else {
      const { video, layer } = player,
        data = args.data || [];
      switch (args.type) {
        case "play":
          await video.play();
          break;
        case "pause":
          video.pause();
          break;
        case "stop":
          video.pause();
          video.currentTime = 0;
          break;
        case "seek":
          if (!Number.isFinite(data[0]) || data[0] < 0)
            throw Error("Invalid seek time");
          video.currentTime = data[0];
          break;
        case "playbackRate":
          if (!Number.isFinite(data[0]) || data[0] <= 0)
            throw Error("Invalid playback rate");
          video.playbackRate = data[0];
          break;
        case "sendDanmu":
          showDanmu(player, data[0], data[1]);
          break;
        case "requestFullScreen":
          await layer.requestFullscreen();
          break;
        case "exitFullScreen":
          if (
            document.fullscreenElement === layer ||
            document.fullscreenElement === video
          )
            await document.exitFullscreen();
          break;
        default:
          throw Error("Unsupported video operation: " + args.type);
      }
    }
    return { videoPlayerId: id };
  }
  const observer = new MutationObserver(() => {
    for (const player of players.values())
      if (!player.host.isConnected) player.cleanup();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  w.addEventListener("pagehide", () => {
    observer.disconnect();
    for (const player of [...players.values()]) player.cleanup();
  });
  // Host control stays in the view process; the service never receives a DOM object.
  w.__runnerVideo = {
    has: (id: number) => players.has(id),
    operate: (args: any) => invoke("operateVideoPlayer", args),
    published(name: string, event: any) {
      const match = /^video_(\d+)_(\d+)_actionChanged$/.exec(
        name.replace(/^custom_event_/, ""),
      );
      if (!match || Number(match[1]) !== w.__webviewId__) return;
      event = event?.data?.method ? event.data : event;
      if (typeof event?.method !== "string") return;
      const id = Number(match[2]),
        player = players.get(id);
      // The 3.17.3 normal-native component's _actionChaned handles play only.
      // Its service may publish other VideoContext actions for the Android
      // capability path. XWeb/dev components have their own complete handlers.
      if (
        !player ||
        (player.host as any).__wxElement?.getVideoType?.() !== "native" ||
        event.method === "play"
      )
        return;
      const args = { videoPlayerId: id, type: event.method, data: event.data };
      invoke("operateVideoPlayer", args).then(
        (result) =>
          w.__runnerObserveNative?.("operateVideoPlayer", args, {
            errMsg: "operateVideoPlayer:ok",
            ...result,
          }),
        (error) => {
          w.__runnerObserveNative?.("operateVideoPlayer", args, {
            errMsg: "operateVideoPlayer:fail " + error.message,
          });
          emit("onVideoError", { videoPlayerId: id, errMsg: error.message });
        },
      );
    },
  };
  return { handles: (name: string) => supported.test(name), invoke };
}
