window.fbAsyncInit = function() {
    FB.init({
        appId      : '1690482414496533',
        xfbml      : true,
        version    : 'v2.4'
    });
    angular.element(document.getElementById('rootController')).scope().initFacebook(FB);
};

(function(d, s, id){
    var js, fjs = d.getElementsByTagName(s)[0];
    if (d.getElementById(id)) {return;}
    js = d.createElement(s); js.id = id;
    js.src = "//connect.facebook.net/en_US/sdk.js";
    fjs.parentNode.insertBefore(js, fjs);
}(document, 'script', 'facebook-jssdk'));

function facebookLogin(){
    angular.element(document.getElementById('rootController')).scope().loggedIn();
}




var app = angular.module('facebookApp',[]);
app.controller('myCtrl', function($scope,$http) {
    $scope.facebookInfo = {isUserLoggedIn: true};
    $scope.facebookPosting = false;
    $scope.message = "";

    $scope.uploadToAllGroups = function()
    {
        $scope.message = "";
        $scope.facebookPosting = true;
        var groupids = ['581177135276026','215717041790502','470611879640060','636420793059167','763236240377621'];
       // var groupids = ['731502030306190'];
        var requests = groupids.length + 2; //one for wwpage and one more for self profile

        var listener = function(res){
            requests--;
            if(requests == 0)
            {
                $scope.facebookPosting = false;
                $scope.message = "uploaded!";
                $scope.$apply();
            }
        };



        if($scope.base64image !=null)
        {
            $scope.uploadImage(function(data){
                for(var i = 0; i < groupids.length; i++)
                {
                    $scope.uploadPhotoToGroup(groupids[i],$scope.facebookMessage, data.data.data.link, listener);
                }
                $scope.uploadPhotoToPageAsAdmin($scope.facebookMessage,data.data.data.link,listener);
                $scope.uploadPhotoToProfile($scope.facebookMessage,data.data.data.link, listener);
            })
        }
        else
        {
            for(var i = 0; i < groupids.length; i++)
            {
                $scope.postToGroup(groupids[i],$scope.facebookMessage, listener);
            }
            $scope.postToPageAsAdmin($scope.facebookMessage,listener);
            $scope.postToProfile($scope.facebookMessage,listener);
        }

    };


    $scope.postToPageAsAdmin = function(message, listener)
    {
        var newToken = "";
        $scope.FB.api('/me/accounts',function(res){
            for(var i =0; i < res.data.length; i++ )
            {
                if(res.data[i].id == "429379410438878") //ww is 429379410438878
                {
                    newToken = res.data[i].access_token;
                }
            }
            $scope.FB.api('/429379410438878/feed',listener,'post', {access_token: newToken, message: message});
        },'get');

    };

    $scope.uploadPhotoToPageAsAdmin = function(message,photoUrl, listener)
    {
        var newToken = "";
        $scope.FB.api('/me/accounts',function(res){
            for(var i =0; i < res.data.length; i++ )
            {
                if(res.data[i].id == "429379410438878") //ww is 429379410438878
                {
                    newToken = res.data[i].access_token;
                }
            }
            $scope.FB.api('/429379410438878/photos',listener,'post', {access_token: newToken, message: message, url: photoUrl});
        },'get');
    };


    $scope.uploadPhotoToProfile = function(message,photoUrl, listener){
        $scope.FB.api('/me/photos',listener,'post', {message: message, url: photoUrl});
    };

    $scope.postToProfile = function(message,listener)
    {
        $scope.FB.api('/me/feed', listener,'post', {message: message});
    };

    $scope.uploadPhotoToGroup = function(groupid,message,photoUrl, listener){
      $scope.FB.api('/' + groupid + '/photos',listener,'post', {message: message, url: photoUrl});
    };

    $scope.postToGroup = function(groupid,message, listener){
        $scope.FB.api('/' + groupid + '/feed', listener,'post', {message: message});
    };

    $scope.loggedIn = function()
    {
        $scope.errorMessage = "";
        $scope.FB.getLoginStatus(function(response) {
            if (response.status === 'connected' && response.authResponse.userID == "136442056694847") {
                $scope.facebookInfo.isUserLoggedIn = true;
            } else {
                $scope.facebookInfo.isUserLoggedIn = false;
            }

             if (response.status === 'connected' && response.authResponse.userID != "136442056694847") {
                $scope.errorMessage = "You must be logged in as the weekend warrior account not your own. Log out and back in.";
            }
            $scope.$apply();
        });
    };

    $scope.isUserLoggedOut = function()
    {
        return  !$scope.facebookInfo.isUserLoggedIn;
    };


    $scope.initFacebook = function(facebook)
    {
        $scope.FB = facebook;
        $scope.errorMessage = "";
        $scope.FB.getLoginStatus(function(response) {
            if (response.status === 'connected' && response.authResponse.userID == "136442056694847") {
                $scope.facebookInfo.isUserLoggedIn = true;
            } else {
                $scope.facebookInfo.isUserLoggedIn = false;
            }
            if (response.status === 'connected' && response.authResponse.userID != "136442056694847") {
                $scope.errorMessage = "You must be logged in as the weekend warrior account not your own. Log out and back in.";
            }
            $scope.$apply();
        });

        $scope.FB.Event.subscribe('auth.logout',function(){
            $scope.facebookInfo.isUserLoggedIn = false;
            $scope.$apply();
        });
    };



    $scope.uploadImage = function(listener) {

        var json = {image: $scope.base64image.split(',')[1]};
        var req = {
            method: 'POST',
            url: 'https://api.imgur.com/3/image',
            headers: {
                'Authorization': 'Client-ID 1e2db2368ae4c05'
            },
            data: json
        };

        $http(req).then(listener, function(data){});
    }
});

app.directive("fileread", [function () {
    return {
        scope: {
            fileread: "="
        },
        link: function (scope, element, attributes) {
            element.bind("change", function (changeEvent) {
                var reader = new FileReader();
                reader.onload = function (loadEvent) {
                    scope.$apply(function () {
                        scope.fileread = loadEvent.target.result;
                    });
                };
                reader.readAsDataURL(changeEvent.target.files[0]);
            });
        }
    }
}]);


