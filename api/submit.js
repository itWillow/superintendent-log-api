// api/submit.js - Handles data extraction and Quickbase submission
export default async function handler(req, res) {
  // Enable CORS - Allow all origins
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { conversationHistory, projectId, userName } = req.body;

    if (!conversationHistory || !Array.isArray(conversationHistory)) {
      return res.status(400).json({ error: 'conversationHistory array is required' });
    }

    console.log('Received pre-filled data:', { projectId, userName });

    // Get today's date
    const today = new Date();
    const day = String(today.getDate()).padStart(2, '0');
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const year = today.getFullYear();
    const todayDate = `${day}-${month}-${year}`;

    // Step 1: Extract data from conversation using Claude
    const extractPrompt = `Based on our entire conversation, extract the following fields in JSON format:

{
  "project": "project name or ID",
  "date": "${todayDate}",
  "name": "superintendent name",
  "weather_summary": "weather description",
  "sub_and_crew_count": "count details",
  "issues_delays": "any issues or 'None'",
  "visitors": "visitor info or 'None'",
  "notes_photos": "notes or 'None'"
}

IMPORTANT: 
- Always use "${todayDate}" for the date field unless the user explicitly mentioned a different date
- Return ONLY the JSON object, no other text.`;


    const extractResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [
          ...conversationHistory,
          { role: 'user', content: extractPrompt }
        ]
      })
    });

    if (!extractResponse.ok) {
      throw new Error('Failed to extract data from conversation');
    }

    const extractData = await extractResponse.json();
    const extractedText = extractData.content[0].text;
    const jsonMatch = extractedText.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      throw new Error('Could not extract JSON from response');
    }
    
    const logData = JSON.parse(jsonMatch[0]);
    
    // Override with pre-filled data if provided
    if (projectId) {
      logData.project = projectId;
      console.log('Using pre-filled project:', projectId);
    }
    if (userName) {
      logData.name = userName;
      console.log('Using pre-filled user:', userName);
    }

    // Step 2: Create conversation transcript
    const transcript = conversationHistory.map(msg => 
      `${msg.role === 'user' ? 'Superintendent' : 'AI'}: ${msg.content}`
    ).join('\n\n');

    console.log('Extracted log data:', logData);
    console.log('Project ID type:', typeof projectId, projectId);

    // Prepare the project value - convert to number if it's numeric
    const projectValue = projectId ? parseInt(projectId, 10) : logData.project;
    
    if (projectId && isNaN(projectValue)) {
      console.error('Project ID is not a valid number:', projectId);
      throw new Error('Project ID must be a numeric value');
    }

    // Step 3: Submit to Quickbase
    const qbPayload = {
      to: process.env.QB_TABLE_ID,
      data: [{
        14: { value: projectValue }, // Related Project (Field 14) - NUMERIC
        6: { value: logData.date },
        19: { value: userName || logData.name }, // Author_User (Field 19) - TEXT
        8: { value: logData.weather_summary },
        9: { value: logData.sub_and_crew_count },
        10: { value: logData.issues_delays },
        11: { value: logData.visitors },
        12: { value: logData.notes_photos },
        13: { value: transcript }
      }]
    };

    console.log('Quickbase payload:', JSON.stringify(qbPayload, null, 2));

    const qbResponse = await fetch('https://api.quickbase.com/v1/records', {
      method: 'POST',
      headers: {
        'QB-Realm-Hostname': process.env.QB_REALM,
        'Authorization': `QB-USER-TOKEN ${process.env.QB_USER_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(qbPayload)
    });

    if (!qbResponse.ok) {
      const errorText = await qbResponse.text();
      console.error('Quickbase error:', errorText);
      throw new Error(`Quickbase submission failed: ${errorText}`);
    }

    const qbResult = await qbResponse.json();

    return res.status(200).json({
      success: true,
      extractedData: logData,
      quickbaseResponse: qbResult
    });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ 
      error: 'Internal server error', 
      details: error.message 
    });
  }
}
