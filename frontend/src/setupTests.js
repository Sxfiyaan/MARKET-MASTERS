const { TextEncoder, TextDecoder } = require("util");

if (typeof global.TextEncoder === "undefined") {
  global.TextEncoder = TextEncoder;
}
if (typeof global.TextDecoder === "undefined") {
  global.TextDecoder = TextDecoder;
}

process.env.REACT_APP_SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL || "https://placeholder-test-project.supabase.co";
process.env.REACT_APP_SUPABASE_PUBLISHABLE_KEY = process.env.REACT_APP_SUPABASE_PUBLISHABLE_KEY || "placeholder-publishable-key";

global.IS_REACT_ACT_ENVIRONMENT = true;
