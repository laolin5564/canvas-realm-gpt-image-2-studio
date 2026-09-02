// tldraw 的样式表约 100KB，只有画布路由用得到，因此从根 layout 挪到这里按路由加载。
import "tldraw/tldraw.css";

export default function CanvasLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
