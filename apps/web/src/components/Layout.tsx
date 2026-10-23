import { Bars3Icon } from '@heroicons/react/24/outline'
import type { ReactNode } from 'react'
import SideNav from './SideNav'
import ThemeToggle from './ThemeToggle'
import { UserMenu } from './UserMenu'

/** Drawer shell: left `SideNav`, sticky top bar (user menu + theme toggle), `<main>`. */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="drawer lg:drawer-open min-h-screen app-canvas">
      <input id="drawer-toggle" type="checkbox" className="drawer-toggle" />

      <div className="drawer-content flex flex-col min-h-screen">
        <header className="app-header sticky top-0 z-30 flex items-center border-b px-3 gap-2 h-14">
          <label
            htmlFor="drawer-toggle"
            className="btn btn-ghost btn-sm btn-square lg:hidden"
            aria-label="Open navigation"
          >
            <Bars3Icon className="w-5 h-5" />
          </label>

          <div className="flex-1" />

          <div className="flex items-center gap-1.5">
            <UserMenu />
            <ThemeToggle />
          </div>
        </header>

        <main className="flex-1 p-4 md:p-8">{children}</main>
      </div>

      <div className="drawer-side z-40">
        <label htmlFor="drawer-toggle" aria-label="Close navigation" className="drawer-overlay" />
        <SideNav />
      </div>
    </div>
  )
}
