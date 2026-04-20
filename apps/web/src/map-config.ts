/**
 * Basemap definitions used by the Leaflet map.
 *
 * Keeping tile URLs here makes it easier to switch imagery providers later
 * without rewriting map components.
 */
export const basemaps = {
  worldLight: {
    key: "worldLight",
    name: "World Light",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors"
  },
  usAerial: {
    key: "usAerial",
    name: "US Aerial Imagery",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution:
      "Tiles &copy; Esri, Maxar, Earthstar Geographics, USDA FSA, USGS, Aerogrid, IGN, and the GIS User Community"
  }
};
