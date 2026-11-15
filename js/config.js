// Public settings for the Life Agent app.
// The publishable key is safe to ship: Row Level Security means it can read nothing
// until you sign in, and then only your own rows. Secret keys never go in this file.
// While supabaseKey is empty, cloud sync is off and the app saves on this device only.
window.LIFE_AGENT_CONFIG = {
  supabaseUrl: "https://zqzihidanrkmnlvjwyqn.supabase.co",
  supabaseKey: "",
};
