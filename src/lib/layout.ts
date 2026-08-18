// Shared responsive layout constants for the desktop shell (sidebar nav +
// widened content past the `lg` breakpoint). Kept in one place so Screen,
// ChatScreen (which has its own wrapper), the Sidebar, and the CaptureFab
// all agree on the same content column — the FAB in particular relies on
// its mirrored container matching this exactly to stay visually anchored
// to the content's right edge instead of the raw viewport corner.
export const SIDEBAR_WIDTH = "lg:w-64";
export const SIDEBAR_OFFSET = "lg:pl-64";
export const CONTENT_MAX_WIDTH = "max-w-md lg:max-w-3xl";
export const CONTENT_PADDING_X = "px-5 lg:px-10";
