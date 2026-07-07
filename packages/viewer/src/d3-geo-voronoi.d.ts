declare module "d3-geo-voronoi" {
  /** Spherical Delaunay of [lon,lat] points. `triangles` are point-index triples. */
  export function geoDelaunay(points: [number, number][]): {
    triangles: number[][];
  };
}
