declare module "d3-geo-voronoi" {
  /** Spherical Delaunay of [lon,lat] points. `triangles` are point-index triples. */
  export function geoDelaunay(points: [number, number][]): {
    triangles: number[][];
    /** Index of the nearest site to (lon,lat); optional start node for warm search. */
    find(x: number, y: number, next?: number): number;
  };
}
