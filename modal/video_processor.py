import os
import modal
import tempfile
import subprocess
import uuid
from typing import BinaryIO, Dict
from fastapi import HTTPException

# Define the Modal app and queue
app = modal.App("video-processor")
queue = modal.Queue.from_name("video-processing-queue", create_if_missing=True)

# Create an image with ffmpeg and required Python packages
image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg")
    .pip_install("boto3", "fastapi")
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
def process_video(job_id: str, video_url: str, audio_url: str) -> None:
    """
    Background task to process video and audio merge
    Puts the result in the queue when done
    """
    try:
        bucket = "cache-aip-us"
        destination_key = f"final-videos/{job_id}.mp4"
        
        # Your existing ffmpeg command setup
        cmd = [
            'ffmpeg',
            '-i', video_url,
            '-i', audio_url,
            '-map', '0:v:0',
            '-map', '1:a:0',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-shortest',
            '-movflags', 'frag_keyframe+empty_moov',
            '-f', 'mp4',
            'pipe:1'
        ]
        
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        
        final_url = stream_to_s3(process.stdout, bucket, destination_key)
        
        stderr = process.communicate()[1]
        if process.returncode != 0:
            queue.put({"job_id": job_id, "status": "error", "error": stderr.decode()})
            return
            
        # Put successful result in queue
        queue.put({
            "job_id": job_id,
            "status": "completed",
            "url": final_url
        })
        
    except Exception as e:
        queue.put({
            "job_id": job_id,
            "status": "error",
            "error": str(e)
        })

@app.function(
    image=image,
    secrets=[modal.Secret.from_name("aws-secret")]
)
@modal.web_endpoint(method="POST")
async def start_merge(data: Dict[str, str]):
    """
    Web endpoint to start video processing
    Expects JSON body with:
    {
        "video_url": "https://...",
        "audio_url": "https://..."
    }
    """
    try:
        video_url = data.get("video_url")
        audio_url = data.get("audio_url")
        
        if not video_url or not audio_url:
            raise HTTPException(status_code=400, detail="Missing video_url or audio_url")
            
        job_id = str(uuid.uuid4())
        
        # Spawn the processing task
        process_video.spawn(job_id, video_url, audio_url)
        
        return {
            "job_id": job_id,
            "status": "processing",
            "message": "Video processing started"
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.function(
    image=image,
    secrets=[modal.Secret.from_name("aws-secret")]
)
@modal.web_endpoint(method="GET")
async def check_status(job_id: str):
    """
    Check the status of a processing job
    """
    try:
        # Try to get the result from the queue
        result = queue.get(timeout=0)
        
        if result and result.get("job_id") == job_id:
            return result
        else:
            # Put the result back if it's not for this job
            if result:
                queue.put(result)
            return {"job_id": job_id, "status": "processing"}
            
    except modal.Queue.Empty:
        return {"job_id": job_id, "status": "processing"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# Update the test function to demonstrate the new flow
@app.local_entrypoint()
def test():
    """Test the function locally"""
    video_url = "https://cache-aip-us.s3.us-east-1.amazonaws.com/processed-audio/original-videos/1733173125620-original-0u1ds4amped-Voice%20Isolator%20Demo.mp4"
    audio_url = "https://cache-aip-us.s3.us-east-1.amazonaws.com/processed-audio/processed-audio/1733173139930-processed-0u1ds4amped-Voice%20Isolator%20Demo.wav"
    
    # Start the merge
    result = start_merge.remote({"video_url": video_url, "audio_url": audio_url})
    print(f"Started processing with job ID: {result['job_id']}")
    
    # Poll for status (in real usage, this would be done by the frontend)
    import time
    while True:
        status = check_status.remote(result['job_id'])
        print(f"Status: {status}")
        if status['status'] != 'processing':
            break
        time.sleep(5) 