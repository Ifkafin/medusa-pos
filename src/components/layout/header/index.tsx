import { Calendar } from "lucide-react";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { useEffect, useState } from "react";
import { useHeader } from "./hooks";
import { useQueryStore } from "@/hooks/queries/useQueryStore";
import { getLogoUrl } from "@/utils/settings/store/metadata";

const Header: React.FC = () => {
  const [now, setNow] = useState(new Date());
  const sidebar = useSidebar();
  const { data: store } = useQueryStore();

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  const { formatDate } = useHeader();

  const logoSrc = getLogoUrl(store);

  return (
    <header className="bg-surface border-b border-theme-border shadow h-24 px-6 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-4">
        {!sidebar.open && <SidebarTrigger />}
      </div>
      {logoSrc && (
        <div>
          <img
            src={logoSrc}
            className="h-8 drop-shadow-lg"
            alt=""
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        </div>
      )}
      <div className="flex gap-1.5 items-center text-fg-muted">
        <span>{formatDate(now)}</span>
        <Calendar />
      </div>
    </header>
  );
};

export default Header;
