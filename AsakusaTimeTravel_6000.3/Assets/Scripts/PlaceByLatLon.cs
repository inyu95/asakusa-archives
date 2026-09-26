using PLATEAU.CityInfo;
using PLATEAU.Native;
using UnityEngine;

public class PlaceByLatLon : MonoBehaviour
{
    public PLATEAUInstancedCityModel city;
    public double latitude = 35.715750;
    public double longitude = 139.793194;
    public double height = 0.0;

    [ContextMenu("Place At LatLon")]
    public void PlaceAtLatLon()
    {
        if (city == null)
        {
            Debug.LogError("city が未設定です");
            return;
        }

        var geo = city.GeoReference;
        var xyz = geo.Project(new GeoCoordinate(latitude, longitude, height));
        transform.position = new Vector3((float)xyz.X, (float)xyz.Y, (float)xyz.Z);
        Debug.Log($"配置位置: {transform.position}");
    }
}