import { Navigate, Route, Routes } from "react-router-dom";
import { CaptureFab } from "./components/CaptureFab";
import { OfflineBanner } from "./components/OfflineBanner";
import { TabBar } from "./components/TabBar";
import { getDailyLandingRoute } from "./lib/dailyLanding";
import { BrowseScreen } from "./screens/BrowseScreen";
import { CaptureScreen } from "./screens/CaptureScreen";
import { ChatScreen } from "./screens/ChatScreen";
import { TodayScreen } from "./screens/TodayScreen";

function DailyLanding() {
  return <Navigate to={getDailyLandingRoute()} replace />;
}

export default function App() {
  return (
    <>
      <OfflineBanner />
      <Routes>
        <Route path="/" element={<DailyLanding />} />
        <Route path="/today" element={<TodayScreen />} />
        <Route path="/chat" element={<ChatScreen />} />
        <Route path="/capture" element={<CaptureScreen />} />
        <Route path="/share-target" element={<Navigate to="/capture" replace />} />
        <Route path="/browse" element={<BrowseScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <CaptureFab />
      <TabBar />
    </>
  );
}
