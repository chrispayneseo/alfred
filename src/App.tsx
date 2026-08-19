import { Navigate, Route, Routes } from "react-router-dom";
import { CaptureFab } from "./components/CaptureFab";
import { LockScreen } from "./components/LockScreen";
import { OfflineBanner } from "./components/OfflineBanner";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { useLockGate } from "./hooks/useLockGate";
import { getDailyLandingRoute } from "./lib/dailyLanding";
import { SIDEBAR_OFFSET } from "./lib/layout";
import { BrowseScreen } from "./screens/BrowseScreen";
import { CaptureScreen } from "./screens/CaptureScreen";
import { ChatScreen } from "./screens/ChatScreen";
import { DigestScreen } from "./screens/DigestScreen";
import { FeedScreen } from "./screens/FeedScreen";
import { FreelanceClientScreen } from "./screens/FreelanceClientScreen";
import { FreelanceScreen } from "./screens/FreelanceScreen";
import { MealPlanScreen } from "./screens/MealPlanScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { TodayScreen } from "./screens/TodayScreen";

function DailyLanding() {
  return <Navigate to={getDailyLandingRoute()} replace />;
}

export default function App() {
  const { locked, unlock } = useLockGate();
  if (locked) return <LockScreen onUnlock={unlock} />;

  return (
    <>
      <OfflineBanner />
      <Sidebar />
      <div className={SIDEBAR_OFFSET}>
        <Routes>
          <Route path="/" element={<DailyLanding />} />
          <Route path="/today" element={<TodayScreen />} />
          <Route path="/chat" element={<ChatScreen />} />
          <Route path="/capture" element={<CaptureScreen />} />
          <Route path="/share-target" element={<Navigate to="/capture" replace />} />
          <Route path="/browse" element={<BrowseScreen />} />
          <Route path="/freelance" element={<FreelanceScreen />} />
          <Route path="/freelance/:client" element={<FreelanceClientScreen />} />
          <Route path="/digest" element={<DigestScreen />} />
          <Route path="/feed" element={<FeedScreen />} />
          <Route path="/meal-plan" element={<MealPlanScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      <CaptureFab />
      <TabBar />
    </>
  );
}
