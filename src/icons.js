import {
  Activity,
  CandlestickChart,
  ChartNoAxesCombined,
  ChevronDown,
  Database,
  FlaskConical,
  Menu,
  Moon,
  Pause,
  Play,
  Settings,
  SlidersHorizontal,
  Sun,
  StepBack,
  StepForward,
} from 'lucide';

const iconNodes = { Activity, CandlestickChart, ChartNoAxesCombined, ChevronDown, Database, FlaskConical, Menu, Moon, Pause, Play, Settings, SlidersHorizontal, StepBack, StepForward, Sun };
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((container) => {
    const iconNode = iconNodes[container.dataset.icon];
    if (!iconNode) return;
    const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
    Object.entries({ width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }).forEach(([name, value]) => svg.setAttribute(name, String(value)));
    iconNode.forEach(([tagName, attributes]) => {
      const element = document.createElementNS(SVG_NAMESPACE, tagName);
      Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, String(value)));
      svg.append(element);
    });
    container.replaceChildren(svg);
  });
}