import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

let geoData: any = null;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const countryCode = searchParams.get('country');

  if (!countryCode) {
    return NextResponse.json({ error: 'Country code is required' }, { status: 400 });
  }

  if (!geoData) {
    try {
      const filePath = path.join(process.cwd(), 'public', 'states.geojson');
      const fileContents = fs.readFileSync(filePath, 'utf8');
      geoData = JSON.parse(fileContents);
    } catch (error) {
      console.error('Error loading states geojson:', error);
      return NextResponse.json({ error: 'Failed to load states data' }, { status: 500 });
    }
  }

  const features = geoData.features.filter((f: any) =>
    f.properties && f.properties.ADM0_A3 === countryCode
  );

  return NextResponse.json({
    type: 'FeatureCollection',
    features: features
  });
}
