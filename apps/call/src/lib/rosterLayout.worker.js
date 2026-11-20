import { UndirectedGraph } from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';

const STEPS = 22;
const settings = {
  barnesHutOptimize: true,
  adjustSizes: true,
  gravity: 0.55,
  scalingRatio: 18,
  slowDown: 3.5,
  strongGravityMode: false,
  edgeWeightInfluence: 0.85,
};

// Posts every 10th iteration as a frame so the page can play the settle back smoothly.
self.onmessage = ({ data }) => {
  const graph = new UndirectedGraph();
  for (const [key, position] of data.nodes) graph.addNode(key, position);
  for (const { player, team } of data.edges) graph.addEdge(player, team);
  const frames = [];
  for (let step = 0; step < STEPS; step++) {
    forceAtlas2.assign(graph, { iterations: 10, settings });
    frames.push(graph.mapNodes((key, { x, y }) => [key, x, y]));
  }
  self.postMessage(frames);
};
