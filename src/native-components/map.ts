import * as L from "leaflet";
import css from "leaflet/dist/leaflet.css";
import gcoord from "gcoord";
export function mapPoint(a: any): [number, number] {
  const latitude = Number(a.latitude ?? a.centerLatitude),
    longitude = Number(a.longitude ?? a.centerLongitude);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    throw Error("Invalid map coordinates");
  const [x, y] = gcoord.transform(
    [longitude, latitude],
    gcoord.GCJ02,
    gcoord.WGS84,
  );
  return [y, x];
}
const wxPoint = (p: L.LatLng) => {
  const [longitude, latitude] = gcoord.transform(
    [p.lng, p.lat],
    gcoord.WGS84,
    gcoord.GCJ02,
  );
  return { latitude, longitude };
};
import { mapNativeMethods as mapMethods } from "./contracts";
/** Native map contract; the real component still owns data, lifecycle and events. */
export function createMapBackend(
  w: any,
  emit: (name: string, data: any) => void,
  native: any,
) {
  const maps = new Map<number, any>();
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  function create(a: any, suppliedHost?: HTMLElement) {
    const id = a.mapId;
    const host =
      suppliedHost ||
      [...document.querySelectorAll<HTMLElement>("wx-map")].find(
        (e: any) =>
          e.__wxElement?.viewId === id ||
          e.__wxElement?.getContextId?.() === id,
      );
    if (!host) throw Error("Map component identity unavailable");
    const layer = document.createElement("div");
    layer.dataset.runnerMap = String(id);
    Object.assign(layer.style, {
      position: "absolute",
      inset: "0",
      zIndex: "0",
    });
    if (getComputedStyle(host).position === "static")
      host.style.position = "relative";
    host.append(layer);
    const map = L.map(layer, {
      zoomControl: true,
      attributionControl: false,
      center: mapPoint(a),
      zoom: a.scale || 16,
      maxZoom: 20,
      minZoom: 3,
    });
    // Business covers can occupy the bottom half of a map. Keep provider credit visible.
    L.control.attribution({ position: "topright" }).addTo(map);
    const provider = native.config().map || {};
    const tile = L.tileLayer(
      provider.tileUrl || "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        maxZoom: 20,
        maxNativeZoom: 19,
        attribution:
          provider.attribution ||
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      },
    ).addTo(map);
    const item: any = {
      id,
      host,
      layer,
      map,
      markers: new Map(),
      lines: new Map(),
      circles: new Map(),
      options: {},
      tileErrors: 0,
      tilesLoaded: 0,
    };
    maps.set(id, item);
    tile.on("tileerror", () => {
      item.tileErrors++;
      native.debug({
        type: "map-resource-error",
        mapId: id,
        source: "tile-provider",
      });
    });
    tile.on("tileload", () => item.tilesLoaded++);
    map.on("click", (e: any) =>
      emit("onMapClick", { mapId: id, ...wxPoint(e.latlng) }),
    );
    map.on("dragstart", () => {
      item.moveCause = "gesture";
    });
    map.on("zoomstart", () => {
      item.moveCause ||= "update";
    });
    map.on("movestart", () =>
      emit("onMapRegionChange", {
        mapId: id,
        type: "begin",
        causedBy: item.moveCause || "update",
      }),
    );
    map.on("moveend", () => {
      emit("onMapRegionChange", {
        mapId: id,
        type: "end",
        causedBy: item.moveCause || "update",
        centerLocation: wxPoint(map.getCenter()),
        scale: map.getZoom(),
      });
      item.moveCause = null;
    });
    item.observer = new ResizeObserver(() => map.invalidateSize());
    item.observer.observe(host);
    return item;
  }
  function location(m: any) {
    if (!m.options.showLocation) {
      m.location?.remove();
      m.location = null;
      return;
    }
    if (m.locationPending || m.location) return;
    m.locationPending = true;
    native
      .nativeRequest("getLocation", { type: "gcj02" })
      .then(
        (point: any) => {
          if (!maps.has(m.id) || !m.options.showLocation) return;
          const icon = L.divIcon({
            className: "runner-map-location",
            html: '<span style="display:block;width:16px;height:16px;background:#2589e8;border:2px solid white;border-radius:50%;box-shadow:0 0 0 6px #2589e830"></span>',
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          });
          m.location = L.marker(mapPoint(point), {
            icon,
            interactive: false,
            zIndexOffset: 1000,
          }).addTo(m.map);
          m.locationError = null;
        },
        (error: any) => {
          m.locationError = error.message;
          native.debug({
            type: "map-location-error",
            mapId: m.id,
            message: error.message,
          });
        },
      )
      .finally(() => {
        m.locationPending = false;
      });
  }
  function markers(m: any, values: any[], clear = false) {
    if (clear) {
      for (const x of m.markers.values()) x.layer.remove();
      m.markers.clear();
    }
    for (const a of values) {
      const point = mapPoint(a);
      m.markers.get(a.id)?.layer.remove();
      const icon = a.iconPath
        ? L.icon({
            iconUrl: a.iconPath,
            iconSize: [parseFloat(a.width) || 30, parseFloat(a.height) || 38],
            iconAnchor: [
              (parseFloat(a.width) || 30) / 2,
              parseFloat(a.height) || 38,
            ],
          })
        : L.divIcon({
            html: '<span style="color:#1687f8;font-size:28px">●</span>',
            className: "runner-map-pin",
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          });
      const marker = L.marker(point, { icon }).addTo(m.map);
      m.markers.set(a.id, { layer: marker, options: a });
      const send = (name: string) =>
        emit(name, { mapId: m.id, data: JSON.stringify({ markerId: a.id }) });
      marker.on("click", () => send("onMapMarkerClick"));
      if (a.callout?.content) {
        const text = document.createElement("span");
        text.textContent = a.callout.content;
        text.style.color = a.callout.color || "#222";
        text.onclick = (e) => {
          e.stopPropagation();
          send("onMapCalloutClick");
        };
        marker.bindTooltip(text, {
          permanent: a.callout.display === "ALWAYS" || a.callout.display === 1,
          direction: "top",
          interactive: true,
          offset: [0, -(parseFloat(a.height) || 38)],
        });
      }
    }
  }
  async function invoke(name: string, a: any) {
    const id = a.mapId;
    if (!Number.isFinite(id)) throw Error("mapId required");
    let m = maps.get(id);
    if (/^remove(XWeb)?Map$/.test(name)) {
      if (m) {
        m.observer.disconnect();
        m.map.remove();
        m.layer.remove();
        maps.delete(id);
      }
      return { mapId: id };
    }
    if (/^insert(XWeb)?Map$/.test(name) && !m) m = create(a);
    if (!m || !m.host.isConnected) throw Error("Map component is stale");
    const map: L.Map = m.map;
    if (/^(insert|update)(XWeb)?Map$/.test(name)) {
      Object.assign(m.options, a);
      m.layer.hidden = !!m.options.hide;
      if (
        a.centerLatitude !== undefined ||
        a.centerLongitude !== undefined ||
        a.scale !== undefined
      )
        map.setView(mapPoint(m.options), m.options.scale || map.getZoom(), {
          animate: false,
        });
      for (const [key, handler] of [
        ["enableScroll", map.dragging],
        ["enableZoom", map.scrollWheelZoom],
      ] as const)
        if (a[key] !== undefined) a[key] ? handler.enable() : handler.disable();
      if (a.markers) markers(m, a.markers, true);
      location(m);
    } else if (name === "getMapCenterLocation") return wxPoint(map.getCenter());
    else if (name === "getMapScale") return { scale: map.getZoom() };
    else if (name === "getMapRegion")
      return {
        southwest: wxPoint(map.getBounds().getSouthWest()),
        northeast: wxPoint(map.getBounds().getNorthEast()),
      };
    else if (name === "moveToMapLocation")
      map.panTo(
        mapPoint(
          a.latitude === undefined
            ? await native.nativeRequest("getLocation", { type: "gcj02" })
            : a,
        ),
      );
    else if (name === "includeMapPoints") {
      if (!a.points?.length) throw Error("points required");
      map.fitBounds(a.points.map(mapPoint), {
        padding: [32, 32],
        animate: false,
      });
    } else if (name === "addMapMarkers" || name === "updateMapMarkers")
      markers(m, a.markers || [], a.clear === true);
    else if (name === "removeMapMarkers")
      for (const key of a.markers || []) {
        m.markers.get(key)?.layer.remove();
        m.markers.delete(key);
      }
    else if (name === "addMapLines" || name === "addMapCircles") {
      const circle = name === "addMapCircles",
        store = circle ? m.circles : m.lines,
        values = circle ? a.circles : a.lines;
      if (a.clear) {
        for (const v of store.values()) v.remove();
        store.clear();
      }
      for (const [i, x] of (values || []).entries()) {
        const key = x.id ?? i;
        store.get(key)?.remove();
        const options = {
          color: x.color || x.strokeColor || "#3388ff",
          weight: x.width || x.strokeWidth || 2,
          fillColor: x.fillColor,
        };
        const layer = circle
          ? L.circle(mapPoint(x), { ...options, radius: x.radius || 0 })
          : L.polyline(x.points.map(mapPoint), options);
        layer.addTo(map);
        store.set(key, layer);
      }
    } else if (name === "removeMapLines" || name === "removeMapCircles") {
      const store = name === "removeMapLines" ? m.lines : m.circles;
      for (const id of a.lines || a.circles || []) {
        store.get(id)?.remove();
        store.delete(id);
      }
    } else throw Error("UNIMPLEMENTED: native." + name);
    return { mapId: id };
  }
  w.__runnerOpenLocation = (args: any) => {
    mapPoint(args);
    const overlay = document.createElement("section");
    overlay.dataset.runnerLocation = "preview";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483000;background:white;display:flex;flex-direction:column";
    const header = document.createElement("div"),
      title = document.createElement("span"),
      close = document.createElement("button"),
      host = document.createElement("div");
    title.textContent = args.name || args.destination || args.address || "位置";
    close.textContent = "返回";
    header.append(close, title);
    header.style.padding = "12px";
    host.style.cssText = "position:relative;flex:1;min-height:200px";
    overlay.append(header, host);
    document.body.append(overlay);
    const id = -Date.now(),
      m = create(
        {
          mapId: id,
          centerLatitude: args.latitude,
          centerLongitude: args.longitude,
          scale: args.scale || 16,
        },
        host,
      );
    markers(m, [
      {
        id: 1,
        ...args,
        callout: { content: title.textContent, display: "ALWAYS" },
      },
    ]);
    close.onclick = () => {
      m.observer.disconnect();
      m.map.remove();
      maps.delete(id);
      overlay.remove();
    };
    return { opened: true, navigationStarted: false };
  };
  w.__runnerMap = {
    has: (id: number) => maps.has(id),
    operate: (a: any) => invoke(a.method, a),
    inspect: (host: Element) => {
      const m = [...maps.values()].find((m) => m.host === host);
      return m
        ? {
            backend: "leaflet",
            mapId: m.id,
            center: wxPoint(m.map.getCenter()),
            coordinateSystem: "gcj02",
            markerCount: m.markers.size,
            showLocation: !!m.location,
            locationError: m.locationError,
            tilesLoaded: m.tilesLoaded,
            tileErrors: m.tileErrors,
          }
        : null;
    },
  };
  window.addEventListener("pagehide", () => {
    for (const m of maps.values()) {
      m.observer.disconnect();
      m.map.remove();
    }
    maps.clear();
  });
  return {
    handles: (n: string) =>
      /^(insert|update|remove)(XWeb)?Map$/.test(n) || mapMethods.has(n),
    invoke,
  };
}
