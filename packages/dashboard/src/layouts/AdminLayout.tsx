import { useEffect, useState } from "react";
import { Routes, Route, NavLink } from "react-router-dom";
import Overview from "../pages/Overview";
import Requests from "../pages/Requests";
import Providers from "../pages/Providers";
import Users from "../pages/Users";
import Settings from "../pages/Settings";
import { clearAuth, getRole } from "../lib/api";

const navItems = [
  {
    to: "/admin", label: "Overview",
    iconPath: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z",
  },
  {
    to: "/admin/requests", label: "Requests",
    iconPath: "M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4",
  },
  {
    to: "/admin/providers", label: "Providers",
    iconPath: "M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01",
  },
  {
    to: "/admin/users", label: "Users",
    iconPath: "M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z",
  },
  {
    to: "/admin/settings", label: "Settings",
    iconPaths: [
      "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z",
      "M15 12a3 3 0 11-6 0 3 3 0 016 0z",
    ],
  },
];

function NavIcon({ item, size }: { item: typeof navItems[number]; size: string }) {
  const paths = item.iconPaths ?? [item.iconPath!];
  return (
    <svg className={size} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      {paths.map((d, i) => <path key={i} strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={d} />)}
    </svg>
  );
}

export default function AdminLayout() {
  const role = getRole();
  const [navCollapsed, setNavCollapsed] = useState(false);

  useEffect(() => {
    const handler = () => setNavCollapsed(true);
    window.addEventListener("collapse-nav", handler);
    return () => window.removeEventListener("collapse-nav", handler);
  }, []);

  const iconSize = navCollapsed ? "w-7 h-7" : "w-5 h-5";

  return (
    <div className="flex h-screen">
      <nav className={`${navCollapsed ? "w-16" : "w-56"} bg-gray-900 text-white flex flex-col gap-1 transition-all duration-200 shrink-0 ${navCollapsed ? "px-2 py-4" : "p-4"}`}>
        <div className={`flex items-center ${navCollapsed ? "justify-center mb-4" : "justify-between mb-6 px-3"}`}>
          {!navCollapsed && <h1 className="text-xl font-bold">TokenParty</h1>}
          <button
            onClick={() => setNavCollapsed(!navCollapsed)}
            className="text-gray-400 hover:text-white p-1 rounded hover:bg-gray-800"
            title={navCollapsed ? "Expand" : "Collapse"}
          >
            {navCollapsed ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" /></svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" /></svg>
            )}
          </button>
        </div>
        {!navCollapsed && <div className="text-xs text-gray-500 uppercase tracking-wide px-3 mb-2">Admin</div>}
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/admin"}
            className={({ isActive }) =>
              `${navCollapsed ? "flex justify-center py-3" : "flex items-center gap-2 px-3 py-2"} rounded text-sm ${isActive ? "bg-gray-700 text-white" : "text-gray-300 hover:bg-gray-800"}`
            }
            title={navCollapsed ? item.label : undefined}
          >
            <NavIcon item={item} size={iconSize} />
            {!navCollapsed && <span>{item.label}</span>}
          </NavLink>
        ))}
        <div className="mt-auto space-y-1">
          {role === "admin" && (
            <NavLink
              to="/"
              className={`block ${navCollapsed ? "py-3 text-center" : "px-3 py-2"} rounded text-sm text-gray-400 hover:bg-gray-800 hover:text-white`}
              title={navCollapsed ? "User Portal" : undefined}
            >
              {navCollapsed ? (
                <svg className="w-7 h-7 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
              ) : (
                <>User Portal &rarr;</>
              )}
            </NavLink>
          )}
          <button
            onClick={() => { clearAuth(); window.location.href = "/login?switch"; }}
            className={`w-full ${navCollapsed ? "py-3" : "px-3 py-2"} rounded text-sm text-gray-400 hover:bg-gray-800 hover:text-white text-left`}
            title={navCollapsed ? "Switch Account" : undefined}
          >
            {navCollapsed ? (
              <svg className="w-7 h-7 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>
            ) : (
              "Switch Account"
            )}
          </button>
        </div>
      </nav>
      <main className="flex-1 overflow-auto p-6">
        <Routes>
          <Route path="/admin" element={<Overview />} />
          <Route path="/admin/requests" element={<Requests mode="admin" />} />
          <Route path="/admin/providers" element={<Providers />} />
          <Route path="/admin/users" element={<Users />} />
          <Route path="/admin/settings" element={<Settings mode="admin" />} />
        </Routes>
      </main>
    </div>
  );
}
