// Octicons (https://github.com/primer/octicons, MIT License, Copyright (c) GitHub Inc.), copied so the content script
// does not bundle the whole icon set for three icons.
const PATHS = {
  globe:
    "M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM5.78 8.75a9.64 9.64 0 0 0 1.363 4.177c.255.426.542.832.857 1.215.245-.296.551-.705.857-1.215A9.64 9.64 0 0 0 10.22 8.75Zm4.44-1.5a9.64 9.64 0 0 0-1.363-4.177c-.307-.51-.612-.919-.857-1.215a9.927 9.927 0 0 0-.857 1.215A9.64 9.64 0 0 0 5.78 7.25Zm-5.944 1.5H1.543a6.507 6.507 0 0 0 4.666 5.5c-.123-.181-.24-.365-.352-.552-.715-1.192-1.437-2.874-1.581-4.948Zm-2.733-1.5h2.733c.144-2.074.866-3.756 1.58-4.948.12-.197.237-.381.353-.552a6.507 6.507 0 0 0-4.666 5.5Zm10.181 1.5c-.144 2.074-.866 3.756-1.58 4.948-.12.197-.237.381-.353.552a6.507 6.507 0 0 0 4.666-5.5Zm2.733-1.5a6.507 6.507 0 0 0-4.666-5.5c.123.181.24.365.353.552.714 1.192 1.436 2.874 1.58 4.948Z",
  alert:
    "M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z",
} as const;

export type IconName = keyof typeof PATHS | "spinner";

const SVG = "http://www.w3.org/2000/svg";

export function createIcon(doc: Document, name: IconName): SVGSVGElement {
  const svg = doc.createElementNS(SVG, "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "currentColor");
  if (name === "spinner") {
    // The shape of Primer's Spinner, turned by GitHub's `anim-rotate`. Not an `octicon`: GitHub's CSS fills those,
    // which would paint the ring solid. It takes the octicons' alignment instead, so it sits where the globe does.
    svg.classList.add("anim-rotate");
    svg.style.verticalAlign = "text-bottom";
    const track = doc.createElementNS(SVG, "circle");
    for (const [key, value] of Object.entries({ cx: "8", cy: "8", r: "7", "stroke-opacity": "0.25" })) {
      track.setAttribute(key, value);
    }
    const arc = doc.createElementNS(SVG, "path");
    arc.setAttribute("d", "M15 8a7.002 7.002 0 00-7-7");
    arc.setAttribute("stroke-linecap", "round");
    for (const shape of [track, arc]) {
      shape.setAttribute("fill", "none");
      shape.setAttribute("stroke", "currentColor");
      shape.setAttribute("stroke-width", "2");
    }
    svg.append(track, arc);
    return svg;
  }
  svg.classList.add("octicon");
  const path = doc.createElementNS(SVG, "path");
  path.setAttribute("d", PATHS[name]);
  svg.append(path);
  return svg;
}
