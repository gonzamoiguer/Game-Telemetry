// Phosphor icons (https://phosphoricons.com, MIT, © 2023 Phosphor Icons), @phosphor-icons/core 2.1.1,
// FILL weight. Path data copied from the package's SVGs so the viewer loads nothing from outside its
// own origin. To add one: copy the `d` of assets/fill/<name>-fill.svg here. All use a 256×256 viewBox.
const NS = "http://www.w3.org/2000/svg";

export const ICONS = {
  checkCircle: "M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm45.66,85.66-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35a8,8,0,0,1,11.32,11.32Z",
  xCircle: "M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm37.66,130.34a8,8,0,0,1-11.32,11.32L128,139.31l-26.34,26.35a8,8,0,0,1-11.32-11.32L116.69,128,90.34,101.66a8,8,0,0,1,11.32-11.32L128,116.69l26.34-26.35a8,8,0,0,1,11.32,11.32L139.31,128Z",
  floppyDisk: "M219.31,72,184,36.69A15.86,15.86,0,0,0,172.69,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V83.31A15.86,15.86,0,0,0,219.31,72ZM208,208H184V152a16,16,0,0,0-16-16H88a16,16,0,0,0-16,16v56H48V48H172.69L208,83.31ZM160,72a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h56A8,8,0,0,1,160,72Z",
  handFist: "M232,120v8A104,104,0,0,1,127.63,232c-54-.19-98-42.06-103.12-94.78a4,4,0,0,1,5.56-4A35.94,35.94,0,0,0,72,122.59a35.92,35.92,0,0,0,53.94,2.33,40.36,40.36,0,0,0,12.87,13A47.94,47.94,0,0,0,120,176a8,8,0,0,0,8.67,8,8.21,8.21,0,0,0,7.33-8.26A32,32,0,0,1,168,144a8,8,0,0,0,8-8.53,8.18,8.18,0,0,0-8.25-7.47H160a24,24,0,0,1-24-24V88h64A32,32,0,0,1,232,120ZM44.73,120C55.57,119.6,64,110.37,64,99.52v-23C64,65.63,55.57,56.4,44.73,56A20,20,0,0,0,24,76v24A20,20,0,0,0,44.73,120Zm56,0c10.84-.39,19.27-9.62,19.27-20.47v-47c0-10.85-8.43-20.08-19.27-20.47A20,20,0,0,0,80,52v48A20,20,0,0,0,100.73,120ZM176,52a20,20,0,0,0-20.73-20C144.43,32.4,136,41.63,136,52.48V72h36a4,4,0,0,0,4-4Z",
  wall: "M232,56V88a4,4,0,0,1-4,4H136V52a4,4,0,0,1,4-4h84A8,8,0,0,1,232,56Zm-4,52H184v44h44a4,4,0,0,0,4-4V112A4,4,0,0,0,228,108ZM88,152h80V108H88Zm-60,0H72V108H28a4,4,0,0,0-4,4v36A4,4,0,0,0,28,152Zm200,16H136v36a4,4,0,0,0,4,4h84a8,8,0,0,0,8-8V172A4,4,0,0,0,228,168ZM28,92h92V52a4,4,0,0,0-4-4H32a8,8,0,0,0-8,8V88A4,4,0,0,0,28,92Zm-4,80v28a8,8,0,0,0,8,8h84a4,4,0,0,0,4-4V168H28A4,4,0,0,0,24,172Z",
  lightning: "M213.85,125.46l-112,120a8,8,0,0,1-13.69-7l14.66-73.33L45.19,143.49a8,8,0,0,1-3-13l112-120a8,8,0,0,1,13.69,7L153.18,90.9l57.63,21.61a8,8,0,0,1,3,12.95Z",
  trashSimple: "M224,56a8,8,0,0,1-8,8h-8V208a16,16,0,0,1-16,16H64a16,16,0,0,1-16-16V64H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,56ZM88,32h80a8,8,0,0,0,0-16H88a8,8,0,0,0,0,16Z",
};

/** Game resource (asset name) → icon. Resources without one show their name only. */
export const RESOURCE_ICONS = {
  Materials: "wall",
  Electricity: "lightning",
  Trash: "trashSimple",
};

/** An inline <svg> for `name`, `size` px, coloured by CSS `color` (currentColor). */
export function iconSvg(name, size = 14, cls = "ico") {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 256 256");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", ICONS[name]);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}
