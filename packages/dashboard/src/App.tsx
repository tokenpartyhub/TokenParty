import { Routes, Route, NavLink, Navigate, useLocation } from "react-router-dom";
import Overview from "./pages/Overview";
import Requests from "./pages/Requests";
import Providers from "./pages/Providers";
import Keys from "./pages/Keys";
import Settings from "./pages/Settings";
import Login from "./pages/Login";
import { getAdminToken, clearAdminToken } from "./lib/api";

const navItems = [
  { to: "/", label: "Overview" },
  { to: "/requests", label: "Requests" },
  { to: "/providers", label: "Providers" },
  { to: "/keys", label: "Keys" },
  { to: "/settings", label: "Settings" },
];

function AuthGuard({ children }: { children: React.ReactNode }) {
  const token = getAdminToken();
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function Layout() {
  return (
    <div className="flex h-screen">
      <nav className="w-56 bg-gray-900 text-white p-4 flex flex-col gap-1">
        <h1 className="text-xl font-bold mb-6 px-3">TokenParty</h1>
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              `px-3 py-2 rounded text-sm ${isActive ? "bg-gray-700 text-white" : "text-gray-300 hover:bg-gray-800"}`
            }
          >
            {item.label}
          </NavLink>
        ))}
        <div className="mt-auto">
          <button
            onClick={() => { clearAdminToken(); window.location.href = "/login"; }}
            className="w-full px-3 py-2 rounded text-sm text-gray-400 hover:bg-gray-800 hover:text-white text-left"
          >
            Logout
          </button>
        </div>
      </nav>
      <main className="flex-1 overflow-auto p-6">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/providers" element={<Providers />} />
          <Route path="/keys" element={<Keys />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  const location = useLocation();

  if (location.pathname === "/login") {
    return <Routes><Route path="/login" element={<Login />} /></Routes>;
  }

  return (
    <AuthGuard>
      <Layout />
    </AuthGuard>
  );
}
