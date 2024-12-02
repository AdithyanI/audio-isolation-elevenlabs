import os
import modal
import tempfile
import subprocess
import uuid
from typing import BinaryIO

# Define the Modal app
app = modal.App("video-processor")

# Create an image with ffmpeg and required Python packages
image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg")
    .pip_install("boto3")
)

def stream_to_s3(stream: BinaryIO, bucket: str, key: str) -> str:
    import boto3

    """Stream data to S3 using multipart upload"""
    s3 = boto3.client(
        's3',
        aws_access_key_id=os.environ['AWS_ACCESS_KEY_ID'],
        aws_secret_access_key=os.environ['AWS_SECRET_ACCESS_KEY'],
        region_name=os.environ['AWS_REGION']
    )
    
    # Initialize multipart upload with Content-Type metadata
    mpu = s3.create_multipart_upload(
        Bucket=bucket, 
        Key=key,
        ContentType='video/mp4'  # Set the MIME type here
    )
    
    try:
        parts = []
        part_number = 1
        
        # Read and upload 25MB chunks
        while True:
            data = stream.read(25 * 1024 * 1024)  # 25MB chunks
            if not data:
                break
                
            # Upload part
            part = s3.upload_part(
                Bucket=bucket,
                Key=key,
                PartNumber=part_number,
                UploadId=mpu['UploadId'],
                Body=data
            )
            
            parts.append({
                'PartNumber': part_number,
                'ETag': part['ETag']
            })
            part_number += 1
        
        # Complete multipart upload
        s3.complete_multipart_upload(
            Bucket=bucket,
            Key=key,
            UploadId=mpu['UploadId'],
            MultipartUpload={'Parts': parts}
        )
        
        return f"https://{bucket}.s3.{os.environ['AWS_REGION']}.amazonaws.com/{key}"
        
    except Exception as e:
        s3.abort_multipart_upload(
            Bucket=bucket,
            Key=key,
            UploadId=mpu['UploadId']
        )
        raise e

@app.function(
    image=image,
    secrets=[modal.Secret.from_name("aws-secret")]
)
def merge_video_audio(video_url: str, audio_url: str) -> str:
    """
    Merge video and audio from public URLs and stream result directly to S3
    Takes only video stream from video_url and only audio stream from audio_url.
    Returns the URL of the merged video
    """
    try:
        bucket = "cache-aip-us"
        destination_key = f"final-videos/{uuid.uuid4()}.mp4"
        
        # Set up ffmpeg command to output to pipe
        cmd = [
            'ffmpeg',
            '-i', video_url,      # Input video
            '-i', audio_url,      # Input audio
            '-map', '0:v:0',      # Take video stream from first input
            '-map', '1:a:0',      # Take audio stream from second input
            '-c:v', 'copy',       # Copy video codec (no re-encoding)
            '-c:a', 'aac',        # Use AAC for audio
            '-shortest',          # End when shortest input ends
            '-movflags', 'frag_keyframe+empty_moov',  # Enable streaming
            '-f', 'mp4',          # Force MP4 format
            'pipe:1'              # Output to pipe
        ]
        
        # Run ffmpeg command and stream output to S3
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        
        # Stream the output to S3
        final_url = stream_to_s3(process.stdout, bucket, destination_key)
        
        # Check for any ffmpeg errors
        stderr = process.communicate()[1]
        if process.returncode != 0:
            raise Exception(f"FFmpeg error: {stderr.decode()}")
            
        return final_url
        
    except Exception as e:
        raise Exception(f"Error processing video: {str(e)}")

@app.local_entrypoint()
def test():
    """Test the function locally"""
    video_url = "https://cache-aip-us.s3.us-east-1.amazonaws.com/processed-audio/original-videos/1733173125620-original-0u1ds4amped-Voice%20Isolator%20Demo.mp4"
    audio_url = "https://cache-aip-us.s3.us-east-1.amazonaws.com/processed-audio/processed-audio/1733173139930-processed-0u1ds4amped-Voice%20Isolator%20Demo.wav"
    result = merge_video_audio.remote(video_url, audio_url)
    print(f"Merged video available at: {result}") 