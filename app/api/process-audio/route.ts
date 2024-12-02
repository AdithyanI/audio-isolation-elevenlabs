import { NextRequest, NextResponse } from 'next/server'
import { ElevenLabsClient } from 'elevenlabs'
import { uploadToS3 } from '@/lib/s3'
import { Readable } from 'stream'
import { Buffer } from 'buffer'

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk))
  }
  
  return Buffer.concat(chunks)
}

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

    // Convert File to ArrayBuffer
    const arrayBuffer = await audio.arrayBuffer()
    const uint8Array = new Uint8Array(arrayBuffer)

    // Process audio with ElevenLabs
    const processedAudio = await client.audioIsolation.audioIsolation({
      audio: new Blob([uint8Array], { type: audio.type })
    })

    // Convert the stream to buffer
    const buffer = await streamToBuffer(processedAudio as unknown as Readable)

    // Generate a unique filename
    const fileName = `${Date.now()}-${audio.name.replace(/\.[^/.]+$/, '')}.wav`

    // Upload to S3 and get the public URL
    const publicUrl = await uploadToS3(buffer, fileName)

    // Return the public URL
    return NextResponse.json({ url: publicUrl })

  } catch (error) {
    console.error('Error processing audio:', error)
    let errorMessage = 'An unexpected error occurred while processing the audio'
    
    if (error instanceof Error) {
      errorMessage = error.message
    }

    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
}

