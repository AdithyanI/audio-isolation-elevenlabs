import { NextRequest, NextResponse } from 'next/server'
import { ElevenLabsClient } from 'elevenlabs'

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.ELEVEN_LABS_API_KEY
    if (!apiKey) {
      throw new Error('ELEVEN_LABS_API_KEY is not set in the environment variables')
    }

    const formData = await req.formData()
    const audio = formData.get('audio') as File

    if (!audio) {
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 })
    }

    const client = new ElevenLabsClient({ apiKey })

    const response = await client.audioIsolation.audioIsolation({
      audio: audio.stream()
    })

    return new NextResponse(response, {
      headers: {
        'Content-Type': 'audio/wav',
      },
    })
  } catch (error) {
    console.error('Error processing audio:', error)
    let errorMessage = 'An unexpected error occurred while processing the audio'
    
    if (error instanceof Error) {
      errorMessage = error.message
    }

    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
}

