// api/test-replicate.js — Diagnostic tool to test your Replicate API token
// Just deploy and visit: https://starprepfinal4.vercel.app/api/test-replicate
// It will tell you EXACTLY what's wrong.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  var results = {
    step1_env_var_name: null,
    step2_token_exists: false,
    step3_token_format: null,
    step4_token_prefix: null,
    step5_token_length: 0,
    step6_replicate_says: null,
    step7_diagnosis: null,
  };

  // Step 1: Check what env var names exist
  var token = process.env.REPLICATE_API_TOKEN;
  results.step1_env_var_name = token ? 'REPLICATE_API_TOKEN is SET' : 'REPLICATE_API_TOKEN is MISSING';

  // Also check common typos
  var altNames = [
    'REPLICATE_TOKEN',
    'REPLICATE_KEY',
    'REPLICATE_API_KEY',
    'REPLICATE_API',
    'replicate_api_token',
  ];
  var foundAlt = [];
  for (var i = 0; i < altNames.length; i++) {
    if (process.env[altNames[i]]) {
      foundAlt.push(altNames[i]);
    }
  }
  if (foundAlt.length > 0) {
    results.step1_env_var_name += ' (ALSO FOUND: ' + foundAlt.join(', ') + ' — these are WRONG names)';
  }

  if (!token) {
    // Try alternate names as fallback for diagnosis
    for (var j = 0; j < altNames.length; j++) {
      if (process.env[altNames[j]]) {
        token = process.env[altNames[j]];
        results.step1_env_var_name += ' — USING ' + altNames[j] + ' instead';
        break;
      }
    }
  }

  if (!token) {
    results.step7_diagnosis = 'NO TOKEN FOUND. Go to Vercel > starprepfinal4 > Settings > Environment Variables and add REPLICATE_API_TOKEN. Make sure it is checked for Production.';
    return res.status(200).json(results);
  }

  // Step 2: Token exists
  results.step2_token_exists = true;

  // Step 3: Check format
  token = token.trim();
  results.step5_token_length = token.length;
  results.step4_token_prefix = token.substring(0, 4) + '...';

  if (token.startsWith('r8_')) {
    results.step3_token_format = 'GOOD — starts with r8_';
  } else if (token.startsWith('Bearer ')) {
    results.step3_token_format = 'BAD — you pasted "Bearer " in front of the token. Remove "Bearer " and just paste the token itself.';
    results.step7_diagnosis = 'Remove "Bearer " prefix from your token in Vercel env vars. Just paste the raw token starting with r8_';
    return res.status(200).json(results);
  } else if (token.startsWith('"') || token.startsWith("'")) {
    results.step3_token_format = 'BAD — token has quotes around it. Remove the quotes.';
    results.step7_diagnosis = 'Remove the quotes from your token in Vercel env vars.';
    return res.status(200).json(results);
  } else {
    results.step3_token_format = 'SUSPICIOUS — Replicate tokens should start with r8_ but yours starts with: ' + token.substring(0, 6);
  }

  // Step 4: Actually call Replicate and see what they say
  try {
    var testRes = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
    });

    var testText = await testRes.text();
    results.step6_replicate_says = 'HTTP ' + testRes.status;

    if (testRes.status === 200) {
      results.step7_diagnosis = 'TOKEN IS VALID. Replicate accepted it. Your token works fine. The problem is somewhere else in the code.';
    } else if (testRes.status === 401) {
      try {
        var errData = JSON.parse(testText);
        results.step6_replicate_says = 'HTTP 401 — ' + (errData.detail || errData.message || testText);
      } catch (e) {
        results.step6_replicate_says = 'HTTP 401 — ' + testText.substring(0, 200);
      }
      results.step7_diagnosis = 'TOKEN IS INVALID OR DISABLED. Go to replicate.com/account/api-tokens. Check if your token is disabled. Create a brand new one, paste it in Vercel, and redeploy.';
    } else if (testRes.status === 403) {
      results.step7_diagnosis = 'TOKEN IS VALID BUT LACKS PERMISSIONS. Your Replicate account may need billing set up or the token may be restricted.';
    } else {
      results.step6_replicate_says = 'HTTP ' + testRes.status + ' — ' + testText.substring(0, 200);
      results.step7_diagnosis = 'UNEXPECTED RESPONSE. Replicate returned status ' + testRes.status + '. This might be a Replicate service issue.';
    }
  } catch (err) {
    results.step6_replicate_says = 'FETCH FAILED — ' + err.message;
    results.step7_diagnosis = 'Could not reach Replicate API. Might be a network issue.';
  }

  return res.status(200).json(results);
}

