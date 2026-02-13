import { ThemeToggle } from "@/components/theme-toggle";
import { ConnectionStatus } from "@/components/connection-status";
import { SidebarTrigger } from "@/components/ui/sidebar";

interface HeaderProps {
  title?: string;
}

export function Header({ title }: HeaderProps) {
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-border/50 bg-background/80 px-4 backdrop-blur-sm">
      <div className="flex items-center gap-3">
        <SidebarTrigger className="h-8 w-8 lg:hidden" />
        {title && (
          <h1 className="text-lg font-semibold">{title}</h1>
        )}
      </div>
      
      <div className="flex items-center gap-4">
        <ConnectionStatus />
        <ThemeToggle />
      </div>
    </header>
  );
}
